import express from "express";
import cors from "cors";
import { EventSource } from "eventsource";
import WebSocket from "ws";
import vader from "vader-sentiment";
import fetch from "node-fetch";

// --- Flags / env ---
const REPLAY = process.env.DEMO_REPLAY === "1";

const app = express();
app.use(cors());

// --- Symbols we track ---
const SYMBOLS = ["BTC", "ETH"];
const BINANCE_SYMBOLS = { BTC: "btcusdt", ETH: "ethusdt" };

// --- Rolling window state ---
const WINDOW_MS = 120_000; // 2 minutes
const priceStore = { BTC: [], ETH: [] };  // each: [{ t, v }]
const infoStore  = { BTC: [], ETH: [] };  // each: [{ t, v }]
const signalCache = { BTC: null, ETH: null };

// --- Energy consumption data cache ---
let energyData = null;
let lastEnergyFetch = 0;
const ENERGY_CACHE_MS = 3600000; // Cache for 1 hour (data updates daily)

{
  const now = Date.now();
  infoStore.BTC.push({ t: now, v: 0 });
  infoStore.ETH.push({ t: now, v: 0 });
}

// --- Impact detection config/state ---
const IMPACT_WINDOW_MS = 60_000; // measure return 60s after spike
const SENT_SPIKE_Z     = 1.2;    // lower threshold so you see events live
const MIN_SEP_MS       = 15_000; // debounce per symbol

const impacts = [];                    // { sym, t, zSentAtSpike, retPct60s }
const lastSpikeAt = { BTC: 0, ETH: 0 };

/* --------------------------- Helpers --------------------------- */
function prune(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}
function delta1m(series) {
  const cutoff = Date.now() - 60_000;
  const recent = series.filter((d) => d.t >= cutoff);
  if (!recent.length) return 0;
  return recent[recent.length - 1].v - recent[0].v;
}
function count1m(series) {
  const cutoff = Date.now() - 60_000;
  return series.filter((d) => d.t >= cutoff).length;
}
function zScore(series) {
  if (series.length < 5) return { z: 0, latest: null };
  const vals = series.map((d) => d.v);
  const latest = vals.at(-1);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varsum = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1);
  const sd = Math.sqrt(varsum) || 1;
  return { z: (latest - mean) / sd, latest };
}

/* --------------------- Signals computation --------------------- */
function computeSignals() {
  for (const sym of SYMBOLS) {
    prune(priceStore[sym]);
    prune(infoStore[sym]);

    const ps = priceStore[sym];
    const is = infoStore[sym];

    // Price side
    let pctPriceDelta = 0;
    const lastPrice = ps.length ? ps[ps.length - 1].v : null;

    if (ps.length >= 2) {
      const pDelta = delta1m(ps);
      const firstP = ps[0]?.v ?? null;
      if (firstP && lastPrice) pctPriceDelta = (pDelta / firstP) * 100;
    }

    // Info/Sentiment side
    const sDelta = is.length ? delta1m(is) : 0;

    // Use diffs → z-scores
    const priceDiffs =
      ps.length >= 2 ? ps.slice(1).map((d, i) => ({ t: d.t, v: d.v - ps[i].v })) : [];
    const infoDiffs =
      is.length >= 2 ? is.slice(1).map((d, i) => ({ t: d.t, v: d.v - is[i].v })) : [];

    const { z: zPrice = 0 } = priceDiffs.length ? zScore(priceDiffs) : { z: 0 };
    const { z: zSent  = 0 } = infoDiffs.length  ? zScore(infoDiffs)  : { z: 0 };
    const divergence = zSent - zPrice;

    // toy predictor (UI only)
    const pred = 0.6 * (zSent || 0) - 0.2 * (zPrice || 0);

    // info volume last minute
    const infoCount = count1m(is);

    // Calculate energy context for this signal
    let energyContext = null;
    if (energyData && energyData[sym] && lastPrice) {
      const energyPerTx = energyData[sym].perTransaction;
      // Estimate hourly transaction volume based on network activity
      const estimatedHourlyTx = sym === "BTC" ? 21600 : 10800; // Rough estimates
      const hourlyEnergyKWh = energyPerTx?.electricalEnergyKWh 
        ? (energyPerTx.electricalEnergyKWh * estimatedHourlyTx)
        : null;
      
      energyContext = {
        energyPerTxKWh: energyPerTx?.electricalEnergyKWh || null,
        carbonPerTxKg: energyPerTx?.carbonFootprintKgCO2 || null,
        estimatedHourlyTx,
        hourlyEnergyKWh: hourlyEnergyKWh ? Number(hourlyEnergyKWh.toFixed(2)) : null,
        annualizedEnergyTWh: energyData[sym].annualized?.electricalEnergyTWh || null,
        annualizedCarbonMt: energyData[sym].annualized?.carbonFootprintMtCO2 || null,
      };
    }

    // Cache current signal
    signalCache[sym] = {
      symbol: sym,
      lastPrice: Number(lastPrice ?? 0),
      priceDelta1mPct: Number((pctPriceDelta || 0).toFixed(3)),
      sentDelta1m: Number((sDelta || 0).toFixed(3)),
      zSent: Number((zSent || 0).toFixed(2)),
      zPrice: Number((zPrice || 0).toFixed(2)),
      divergence: Number((divergence || 0).toFixed(2)),
      predictedNextReturn: Number(pred.toFixed(2)),
      lastPriceTs: ps.at(-1)?.t ?? null,
      lastInfoTs: is.at(-1)?.t ?? null,
      infoCount1m: infoCount,
      strong: Math.abs(divergence) >= 1.5 && infoCount >= 3,
      updatedAt: new Date().toISOString(),
      counts: { price: ps.length, info: is.length },
      ...(energyContext && { energy: energyContext }),
    };

    // ---------- Impact detection (zSent spike) ----------
    if (zSent != null && Math.abs(zSent) >= SENT_SPIKE_Z) {
      const now = Date.now();
      if (now - lastSpikeAt[sym] >= MIN_SEP_MS) {
        lastSpikeAt[sym] = now;

        const p0 = lastPrice || ps.at(-1)?.v || null;
        const zAt = Number((zSent || 0).toFixed(2));

        if (p0) {
          setTimeout(() => {
            const p1 = priceStore[sym].at(-1)?.v || p0;
            const retPct = ((p1 - p0) / p0) * 100;

            // Calculate energy-related metrics for this impact
            let energyMetrics = null;
            if (energyData && energyData[sym]) {
              const energyPerTx = energyData[sym].perTransaction;
              // Estimate transactions in the 60s window (roughly 6 blocks for BTC)
              const estimatedTxInWindow = sym === "BTC" ? 600 : 180; // BTC ~10 tx/sec avg, ETH ~3 tx/sec
              const energyCostKWh = energyPerTx?.electricalEnergyKWh 
                ? (energyPerTx.electricalEnergyKWh * estimatedTxInWindow) 
                : null;
              const carbonCostKg = energyPerTx?.carbonFootprintKgCO2
                ? (energyPerTx.carbonFootprintKgCO2 * estimatedTxInWindow)
                : null;

              energyMetrics = {
                energyPerTxKWh: energyPerTx?.electricalEnergyKWh || null,
                estimatedTxInWindow,
                totalEnergyCostKWh: energyCostKWh ? Number(energyCostKWh.toFixed(2)) : null,
                totalCarbonCostKg: carbonCostKg ? Number(carbonCostKg.toFixed(2)) : null,
              };
            }

            impacts.push({
              sym,
              t: now,
              zSentAtSpike: zAt,
              retPct60s: Number(retPct.toFixed(3)),
              priceAtSpike: p0,
              priceAfter60s: p1,
              ...(energyMetrics && { energy: energyMetrics }),
            });
            if (impacts.length > 100) impacts.shift();
            console.log("[impact]", sym, "z:", zAt, "ret60s:", retPct.toFixed(3) + "%", 
              energyMetrics ? `energy: ${energyMetrics.totalEnergyCostKWh}kWh` : "");
          }, IMPACT_WINDOW_MS);
        }
      }
    }
  }
}

/* -------------------------- Binance WS ------------------------- */
function startBinance() {
  const streams = SYMBOLS.map((s) => `${BINANCE_SYMBOLS[s]}@trade`).join("/");
  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  const ws = new WebSocket(url);

  ws.on("open", () => console.log("[binance] connected"));
  ws.on("message", (raw) => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
      if (!data?.p) return;
      const sym = stream.startsWith("btcusdt") ? "BTC" : "ETH";
      priceStore[sym].push({ t: Date.now(), v: parseFloat(data.p) });
      if (priceStore[sym].length > 2000) priceStore[sym].splice(0, 500);
    } catch {}
  });
  ws.on("close", () => {
    console.log("[binance] closed; retrying");
    setTimeout(startBinance, 3000);
  });
  ws.on("error", (e) => console.log("[binance] error", e.message));
}

/* ------------------------ Wikimedia SSE ------------------------ */
function startWikimedia() {
  const es = new EventSource("https://stream.wikimedia.org/v2/stream/recentchange");
  es.onopen = () => console.log("[wiki] connected");
  es.onerror = (e) => console.log("[wiki] error", e?.message || "error");
  es.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      const title = String(data?.title || "").toLowerCase();
      if (!title) return;

      const hits = [];
      if (title.includes("bitcoin") || title.includes("btc")) hits.push("BTC");
      if (title.includes("ethereum") || title.includes("eth")) hits.push("ETH");
      if (!hits.length) return;

      const score =
        vader.SentimentIntensityAnalyzer.polarity_scores(data.title).compound; // [-1, 1]
      const t = Date.now();

      for (const sym of hits) {
        infoStore[sym].push({ t, v: score });
        if (infoStore[sym].length > 2000) infoStore[sym].splice(0, 500);
      }
    } catch {}
  };
}

/* ------------------------- NewsAPI poller ---------------------- */
function normalizeSymFromText(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("bitcoin") || t.includes("btc")) return "BTC";
  if (t.includes("ethereum") || t.includes("eth")) return "ETH";
  return null;
}
async function pollNews() {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) return;
  try {
    const url =
      `https://newsapi.org/v2/everything?` +
      `q=(bitcoin OR btc OR ethereum OR eth)&language=en&sortBy=publishedAt&pageSize=10&apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NewsAPI ${res.status}`);
    const json = await res.json();
    const now = Date.now();
    (json.articles || []).forEach((a) => {
      const title = a?.title || "";
      const sym = normalizeSymFromText(title);
      if (!sym) return;
      const score = vader.SentimentIntensityAnalyzer.polarity_scores(title).compound;
      infoStore[sym].push({ t: now, v: score });
      if (infoStore[sym].length > 2000) infoStore[sym].splice(0, 500);
    });
    if ((json.articles || []).length) {
      console.log(`[news] +${json.articles.length} headlines`);
    }
  } catch (e) {
    console.log("[news] error", e.message);
  }
}

/* ------------------------ Digiconomist Energy Data ------------------------ */
async function fetchEnergyData() {
  const now = Date.now();
  // Only fetch if cache expired
  if (energyData && (now - lastEnergyFetch) < ENERGY_CACHE_MS) {
    return energyData;
  }

  try {
    // Digiconomist API for Bitcoin
    const btcResponse = await fetch("https://digiconomist.net/api/v1/bitcoin");
    if (!btcResponse.ok) throw new Error(`Digiconomist API ${btcResponse.status}`);
    const btcData = await btcResponse.json();

    // Try to fetch Ethereum data if available
    let ethData = null;
    try {
      const ethResponse = await fetch("https://digiconomist.net/api/v1/ethereum");
      if (ethResponse.ok) {
        ethData = await ethResponse.json();
      }
    } catch (e) {
      console.log("[energy] Ethereum data not available");
    }

    // Parse and structure the data (handle different possible API response formats)
    energyData = {
      BTC: {
        annualized: {
          carbonFootprintMtCO2: btcData.carbon_footprint_mt_co2 || btcData.annualized_total_footprints?.carbon_footprint_mt_co2 || btcData.carbon_footprint || null,
          electricalEnergyTWh: btcData.energy_consumption_twh || btcData.annualized_total_footprints?.electrical_energy_twh || btcData.electrical_energy || null,
          electronicWasteKt: btcData.electronic_waste_kt || btcData.annualized_total_footprints?.electronic_waste_kt || btcData.electronic_waste || null,
          freshWaterConsumptionGL: btcData.fresh_water_consumption_gl || btcData.annualized_total_footprints?.fresh_water_consumption_gl || btcData.fresh_water || null,
        },
        perTransaction: {
          carbonFootprintKgCO2: btcData.single_transaction_footprints?.carbon_footprint_kg_co2 || btcData.per_transaction?.carbon_footprint_kg_co2 || null,
          electricalEnergyKWh: btcData.single_transaction_footprints?.electrical_energy_kwh || btcData.per_transaction?.electrical_energy_kwh || btcData.energy_per_transaction_kwh || null,
          electronicWasteGrams: btcData.single_transaction_footprints?.electronic_waste_grams || btcData.per_transaction?.electronic_waste_grams || null,
          freshWaterConsumptionLiters: btcData.single_transaction_footprints?.fresh_water_consumption_liters || btcData.per_transaction?.fresh_water_consumption_liters || null,
        },
        updatedAt: btcData.date || new Date().toISOString(),
      },
      ...(ethData && {
        ETH: {
          annualized: {
            carbonFootprintMtCO2: ethData.carbon_footprint_mt_co2 || ethData.annualized_total_footprints?.carbon_footprint_mt_co2 || null,
            electricalEnergyTWh: ethData.energy_consumption_twh || ethData.annualized_total_footprints?.electrical_energy_twh || null,
            electronicWasteKt: ethData.electronic_waste_kt || ethData.annualized_total_footprints?.electronic_waste_kt || null,
            freshWaterConsumptionGL: ethData.fresh_water_consumption_gl || ethData.annualized_total_footprints?.fresh_water_consumption_gl || null,
          },
          perTransaction: {
            carbonFootprintKgCO2: ethData.single_transaction_footprints?.carbon_footprint_kg_co2 || null,
            electricalEnergyKWh: ethData.single_transaction_footprints?.electrical_energy_kwh || ethData.energy_per_transaction_kwh || null,
            electronicWasteGrams: ethData.single_transaction_footprints?.electronic_waste_grams || null,
            freshWaterConsumptionLiters: ethData.single_transaction_footprints?.fresh_water_consumption_liters || null,
          },
          updatedAt: ethData.date || new Date().toISOString(),
        },
      }),
    };

    lastEnergyFetch = now;
    console.log("[energy] Fetched energy consumption data");
    return energyData;
  } catch (e) {
    console.log("[energy] error", e.message);
    return energyData; // Return cached data if fetch fails
  }
}

/* ---------------------------- API ------------------------------ */
setInterval(computeSignals, 1000);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/energy", async (_req, res) => {
  try {
    const data = await fetchEnergyData();
    res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
    res.json(data);
  } catch (err) {
    console.error("energy route error:", err);
    res.status(500).json({ error: "Failed to fetch energy data" });
  }
});

app.get("/signals", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    
    // Always include energy data for linking
    const energy = await fetchEnergyData();
    
    // Calculate analytics linking all three datasets
    const analytics = calculateUnifiedAnalytics(energy);
    
    res.json({
      windowSeconds: WINDOW_MS / 1000,
      symbols: SYMBOLS,
      data: SYMBOLS.map((s) => signalCache[s]).filter(Boolean),
      impacts: impacts.slice(-10), // last 10 impacts for UI/KPIs
      energy, // Always include energy data
      analytics, // Unified analytics
    });
  } catch (err) {
    console.error("signals route error:", err);
    res.status(200).json({
      windowSeconds: WINDOW_MS / 1000,
      symbols: SYMBOLS,
      data: [],
      impacts: [],
      error: "temporary",
    });
  }
});

/* --------------------- Unified Analytics --------------------- */
function calculateUnifiedAnalytics(energy) {
  if (!energy) return null;

  const last10Impacts = impacts.slice(-10);
  const btcImpacts = last10Impacts.filter((i) => i.sym === "BTC");
  const ethImpacts = last10Impacts.filter((i) => i.sym === "ETH");

  // Calculate total energy cost of recent impacts
  let totalImpactEnergyKWh = 0;
  let totalImpactCarbonKg = 0;
  
  last10Impacts.forEach((impact) => {
    if (impact.energy) {
      totalImpactEnergyKWh += impact.energy.totalEnergyCostKWh || 0;
      totalImpactCarbonKg += impact.energy.totalCarbonCostKg || 0;
    }
  });

  // Calculate correlation metrics
  const avgPriceChange = last10Impacts.length > 0
    ? last10Impacts.reduce((sum, i) => sum + Math.abs(i.retPct60s || 0), 0) / last10Impacts.length
    : 0;

  const avgSentimentSpike = last10Impacts.length > 0
    ? last10Impacts.reduce((sum, i) => sum + Math.abs(i.zSentAtSpike || 0), 0) / last10Impacts.length
    : 0;

  return {
    recentImpacts: {
      count: last10Impacts.length,
      btcCount: btcImpacts.length,
      ethCount: ethImpacts.length,
      totalEnergyCostKWh: Number(totalImpactEnergyKWh.toFixed(2)),
      totalCarbonCostKg: Number(totalImpactCarbonKg.toFixed(2)),
      avgPriceChange: Number(avgPriceChange.toFixed(3)),
      avgSentimentSpike: Number(avgSentimentSpike.toFixed(2)),
    },
    networkMetrics: {
      BTC: energy.BTC ? {
        energyPerTxKWh: energy.BTC.perTransaction?.electricalEnergyKWh || null,
        carbonPerTxKg: energy.BTC.perTransaction?.carbonFootprintKgCO2 || null,
        annualEnergyTWh: energy.BTC.annualized?.electricalEnergyTWh || null,
        annualCarbonMt: energy.BTC.annualized?.carbonFootprintMtCO2 || null,
      } : null,
      ETH: energy.ETH ? {
        energyPerTxKWh: energy.ETH.perTransaction?.electricalEnergyKWh || null,
        carbonPerTxKg: energy.ETH.perTransaction?.carbonFootprintKgCO2 || null,
        annualEnergyTWh: energy.ETH.annualized?.electricalEnergyTWh || null,
        annualCarbonMt: energy.ETH.annualized?.carbonFootprintMtCO2 || null,
      } : null,
    },
  };
}

/* --------------------------- Start ----------------------------- */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`server :${PORT}`);
  startBinance();
  if (process.env.NEWSAPI_KEY) {
    console.log("[news] using NewsAPI (20s polling)");
    setInterval(pollNews, 20_000);
  } else {
    console.log("[news] NEWSAPI_KEY not set → using Wikimedia SSE fallback");
    startWikimedia();
  }
});

// --- Optional DEMO replay (if you want offline) ---
if (REPLAY) {
  console.log("[demo] DEMO_REPLAY=1 → synthetic ticks");
  setInterval(() => {
    const t = Date.now();
    for (const sym of SYMBOLS) {
      const last = priceStore[sym].at(-1)?.v || (sym === "BTC" ? 40000 : 2500);
      const p = last * (1 + (Math.random() - 0.5) / 1000); // tiny random walk
      const s = (Math.random() - 0.5) / 4;                 // synthetic sentiment
      priceStore[sym].push({ t, v: p });
      infoStore[sym].push({ t, v: s });
      if (priceStore[sym].length > 2000) priceStore[sym].splice(0, 500);
      if (infoStore[sym].length  > 2000) infoStore[sym].splice(0, 500);
    }
  }, 1000);
}
