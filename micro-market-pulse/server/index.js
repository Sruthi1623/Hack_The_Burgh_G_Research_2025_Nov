import express from "express";
import cors from "cors";
import { EventSource } from "eventsource";
import WebSocket from "ws";
import vader from "vader-sentiment";
import fetch from "node-fetch";

// --- Flags / env ---
const REPLAY = process.env.DEMO_REPLAY === "1";

// Signal thresholds (tweak as you like)
const STRONG_Z = 1.5;           // strong divergence threshold
const MIN_INFO = 3;             // min info events in last minute

// Linkage (info -> price impact) config
const SPIKE_Z = 1.2;            // how big a zSent jump counts as a spike
const IMPACT_WINDOW_MS = 60_000; // measure price move 60s after spike
const SPIKE_COOLDOWN_MS = 30_000; // don't re-trigger too frequently per symbol

const app = express();
app.use(cors());

// Symbols
const SYMBOLS = ["BTC", "ETH"];
const BINANCE_SYMBOLS = { BTC: "btcusdt", ETH: "ethusdt" };

// Rolling window
const WINDOW_MS = 120_000; // 2 minutes
const priceStore = { BTC: [], ETH: [] };  // arrays of { t, v }
const infoStore  = { BTC: [], ETH: [] };
const signalCache = { BTC: null, ETH: null };

// Linkage bookkeeping
const pendingImpacts = []; // [{ sym, t, zSentAtSpike, startPrice }]
const impactsLog = [];     // [{ sym, t, zSentAtSpike, retPct60s }]
const lastSentSpikeAt = { BTC: 0, ETH: 0 };

// --- Seed neutral info point so UI isn't empty at startup ---
{
  const __now = Date.now();
  infoStore.BTC.push({ t: __now, v: 0 });
  infoStore.ETH.push({ t: __now, v: 0 });
}

// --- DEMO REPLAY MODE (offline / fallback) ---
if (REPLAY) {
  console.log("[demo] DEMO_REPLAY=1 → using synthetic ticks");
  setInterval(() => {
    const t = Date.now();
    for (const sym of SYMBOLS) {
      const last = priceStore[sym].at(-1)?.v || (sym === "BTC" ? 40_000 : 2_500);
      const p = last * (1 + (Math.random() - 0.5) / 1000); // small random walk
      const s = (Math.random() - 0.5) / 4;                 // synthetic sentiment
      priceStore[sym].push({ t, v: p });
      infoStore[sym].push({ t, v: s });
      if (priceStore[sym].length > 2000) priceStore[sym].splice(0, 500);
      if (infoStore[sym].length  > 2000) infoStore[sym].splice(0, 500);
    }
  }, 1000);
}

// ------------------------- Helpers -------------------------
function prune(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}
function delta1m(series) {
  const cutoff = Date.now() - 60_000;
  const recent = series.filter(d => d.t >= cutoff);
  if (!recent.length) return 0;
  return recent[recent.length - 1].v - recent[0].v;
}
function count1m(series) {
  const cutoff = Date.now() - 60_000;
  return series.filter(d => d.t >= cutoff).length;
}
function zScore(series) {
  if (series.length < 5) return { z: 0, latest: null };
  const vals = series.map(d => d.v);
  const latest = vals.at(-1);
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
  const varsum = vals.reduce((a,b)=>a+(b-mean)**2,0) / Math.max(1, vals.length-1);
  const sd = Math.sqrt(varsum) || 1;
  return { z: (latest - mean) / sd, latest };
}
// price nearest at/after time t0
function priceAtOrAfter(series, t0) {
  if (!series.length) return null;
  const idx = series.findIndex(p => p.t >= t0);
  if (idx === -1) return series[series.length - 1].v;
  return series[idx].v;
}

// quick lead–lag (very coarse, last ~5 minutes)
function quickLeadLag(sym) {
  try {
    const lookMs = 5 * 60_000;
    const cutoff = Date.now() - lookMs;
    const ps = priceStore[sym].filter(p => p.t >= cutoff);
    const is = infoStore[sym].filter(p => p.t >= cutoff);
    if (ps.length < 8 || is.length < 8) return { bestLagSec: 0, corr: 0 };

    const pDiff = ps.slice(1).map((d, i) => d.v - ps[i].v);
    const sDiff = is.slice(1).map((d, i) => d.v - is[i].v);

    const N = Math.min(pDiff.length, sDiff.length);
    const p = pDiff.slice(-N);
    const s = sDiff.slice(-N);
    const lags = [ -60, -30, -15, 0, 15, 30, 60 ];
    let best = { bestLagSec: 0, corr: 0 };

    for (const L of lags) {
      const shift = Math.round((L / lookMs) * N); // crude alignment
      const a = p.slice(Math.max(0, shift), Math.min(N, N + shift));
      const b = s.slice(Math.max(0, -shift), Math.min(N, N - shift));
      const M = Math.min(a.length, b.length);
      if (M < 8) continue;

      const mean = xs => xs.reduce((x,y)=>x+y,0)/xs.length;
      const ma = mean(a), mb = mean(b);
      let num=0, da=0, db=0;
      for (let i=0;i<M;i++){ const xa=a[i]-ma, xb=b[i]-mb; num+=xa*xb; da+=xa*xa; db+=xb*xb; }
      const corr = (da&&db) ? (num / Math.sqrt(da*db)) : 0;
      if (Math.abs(corr) > Math.abs(best.corr)) best = { bestLagSec: L, corr: Number(corr.toFixed(2)) };
    }
    return best;
  } catch {
    return { bestLagSec: 0, corr: 0 };
  }
}

// -------------------- Signals computation ------------------
function computeSignals() {
  for (const sym of SYMBOLS) {
    prune(priceStore[sym]);
    prune(infoStore[sym]);

    const ps = priceStore[sym];
    const is = infoStore[sym];

    // ---- Price side ----
    let pctPriceDelta = 0;
    const lastPrice = ps.length ? ps[ps.length - 1].v : null;
    if (ps.length >= 2) {
      const pDelta = delta1m(ps); // absolute delta over 1m
      const firstP = ps[0]?.v ?? null;
      if (firstP && lastPrice) pctPriceDelta = (pDelta / firstP) * 100;
    }

    // ---- Info/Sent side ----
    const sDelta = is.length ? delta1m(is) : 0;

    const priceDiffs = ps.length >= 2
      ? ps.slice(1).map((d, i) => ({ t: d.t, v: d.v - ps[i].v }))
      : [];
    const infoDiffs  = is.length >= 2
      ? is.slice(1).map((d, i) => ({ t: d.t, v: d.v - is[i].v }))
      : [];

    const { z: zPrice = 0 } = priceDiffs.length ? zScore(priceDiffs) : { z: 0 };
    const { z: zSent  = 0 } = infoDiffs.length  ? zScore(infoDiffs)  : { z: 0 };
    const divergence = zSent - zPrice;

    // toy predictor
    const pred = 0.6 * (zSent || 0) - 0.2 * (zPrice || 0);

    // info volume in last minute
    const infoCount = count1m(is);

    // --- Sentiment spike detection (for linkage logging) ---
    const now = Date.now();
    if (Math.abs(zSent) >= SPIKE_Z && infoCount >= MIN_INFO) {
      if (now - lastSentSpikeAt[sym] >= SPIKE_COOLDOWN_MS) {
        const startPrice = priceAtOrAfter(ps, now);
        if (startPrice != null) {
          pendingImpacts.push({ sym, t: now, zSentAtSpike: zSent, startPrice });
          lastSentSpikeAt[sym] = now;
        }
      }
    }

    signalCache[sym] = {
      symbol: sym,
      lastPrice: Number(lastPrice ?? 0),
      priceDelta1mPct: Number((pctPriceDelta || 0).toFixed(3)),
      sentDelta1m: Number((sDelta || 0).toFixed(3)),
      zSent: Number((zSent || 0).toFixed(2)),
      zPrice: Number((zPrice || 0).toFixed(2)),
      divergence: Number((divergence || 0).toFixed(2)),

      // extras
      predictedNextReturn: Number(pred.toFixed(2)),
      lastPriceTs: ps.at(-1)?.t ?? null,
      lastInfoTs:  is.at(-1)?.t ?? null,
      infoCount1m: infoCount,
      strong: Math.abs(divergence) >= STRONG_Z && infoCount >= MIN_INFO,

      updatedAt: new Date().toISOString(),
      counts: { price: ps.length, info: is.length },
    };
  }
}

// After IMPACT_WINDOW_MS, compute realized price move and log it
function processPendingImpacts() {
  const now = Date.now();
  for (let i = pendingImpacts.length - 1; i >= 0; i--) {
    const ev = pendingImpacts[i];
    if (now - ev.t >= IMPACT_WINDOW_MS) {
      const ps = priceStore[ev.sym];
      const endPrice = ps.length ? ps[ps.length - 1].v : null;
      if (endPrice != null && ev.startPrice) {
        const retPct60s = ((endPrice - ev.startPrice) / ev.startPrice) * 100;
        impactsLog.push({
          sym: ev.sym,
          t: ev.t,
          zSentAtSpike: Number(ev.zSentAtSpike.toFixed(2)),
          retPct60s: Number(retPct60s.toFixed(3)),
        });
        if (impactsLog.length > 50) impactsLog.splice(0, impactsLog.length - 50);
      }
      pendingImpacts.splice(i, 1);
    }
  }
}

// --------------------- Market / Info streams ----------------
function startBinance() {
  const streams = SYMBOLS.map(s => `${BINANCE_SYMBOLS[s]}@trade`).join("/");
  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  const ws = new WebSocket(url);

  ws.on("open", () => console.log("[binance] connected"));
  ws.on("message", raw => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
      if (!data?.p) return;
      const sym = stream.startsWith("btcusdt") ? "BTC" : "ETH";
      priceStore[sym].push({ t: Date.now(), v: parseFloat(data.p) });
      if (priceStore[sym].length > 2000) priceStore[sym].splice(0, 500);
    } catch {}
  });
  ws.on("close", () => { console.log("[binance] closed; retrying"); setTimeout(startBinance, 3000); });
  ws.on("error", e => console.log("[binance] error", e.message));
}

function startWikimedia() {
  const es = new EventSource("https://stream.wikimedia.org/v2/stream/recentchange");
  es.onopen = () => console.log("[wiki] connected");
  es.onerror = e => console.log("[wiki] error", e?.message || "error");
  es.onmessage = evt => {
    try {
      const data = JSON.parse(evt.data);
      const title = String(data?.title || "").toLowerCase();
      if (!title) return;

      const hits = [];
      if (title.includes("bitcoin") || title.includes("btc")) hits.push("BTC");
      if (title.includes("ethereum") || title.includes("eth")) hits.push("ETH");
      if (!hits.length) return;

      const score = vader.SentimentIntensityAnalyzer.polarity_scores(data.title).compound;
      const t = Date.now();
      for (const sym of hits) {
        infoStore[sym].push({ t, v: score });
        if (infoStore[sym].length > 2000) infoStore[sym].splice(0, 500);
      }
    } catch {}
  };
}

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
    (json.articles || []).forEach(a => {
      const title = a?.title || "";
      const sym = normalizeSymFromText(title);
      if (!sym) return;
      const score = vader.SentimentIntensityAnalyzer.polarity_scores(title).compound;
      infoStore[sym].push({ t: now, v: score });
      if (infoStore[sym].length > 2000) infoStore[sym].splice(0, 500);
    });
    if ((json.articles || []).length) console.log(`[news] +${json.articles.length} headlines`);
  } catch (e) {
    console.log("[news] error", e.message);
  }
}

// -------------------------- API ----------------------------
setInterval(computeSignals, 1000);
setInterval(processPendingImpacts, 1000);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/signals", (_req, res) => {
  try {
    const payload = {
      windowSeconds: WINDOW_MS / 1000,
      symbols: SYMBOLS,
      data: SYMBOLS.map(s => ({
        ...signalCache[s],
        // optional quick lead–lag hint (per symbol)
        leadlag: quickLeadLag(s)
      })).filter(Boolean),
      // latest measured info->price impacts
      impacts: impactsLog.slice(-10),
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(payload);
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

// ------------------------ Start ----------------------------
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
