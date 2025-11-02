import { useEffect, useMemo, useRef, useState } from "react";
import Plot from "react-plotly.js";

export default function App() {
  // ---------- state / refs ----------
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState("BTC");
  const [soundOn, setSoundOn] = useState(false);

  const [impacts, setImpacts] = useState([]);
  const impactsRef = useRef([]);

  const historyRef = useRef({ BTC: [], ETH: [] });
  const audioCtxRef = useRef(null);
  const lastBeepRef = useRef(0);

  // Auto Summary state
  const [summary, setSummary] = useState({ text: "Waiting for live data…", ts: Date.now() });
  const prevRowsRef = useRef(null);
  const prevImpactCountRef = useRef(0);

  // Energy consumption data state and analytics
  const [energyData, setEnergyData] = useState(null);
  const [analytics, setAnalytics] = useState(null);

  // ---------- audio ----------
  const toggleAudio = () => {
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    }
    setSoundOn((v) => !v);
  };

  // ---------- polling ----------
  useEffect(() => {
    let timer;

    const fetchData = async () => {
      try {
        const res = await fetch("/signals");
        if (!res.ok) return;
        const json = await res.json();

        const data = Array.isArray(json.data) ? json.data : [];
        const newImpacts = Array.isArray(json.impacts) ? json.impacts : [];
        const newEnergyData = json.energy || null;
        const newAnalytics = json.analytics || null;

        // rows
        setRows(data);

        // Update energy data and analytics if available
        if (newEnergyData) setEnergyData(newEnergyData);
        if (newAnalytics) setAnalytics(newAnalytics);

        // history + optional audio ping for “strong”
        const h = historyRef.current;
        const now = Date.now();

        data.forEach((r) => {
          const arr = h[r.symbol] || [];
          arr.push({ t: now, g: r.divergence ?? 0 });
          if (arr.length > 150) arr.shift();
          h[r.symbol] = arr;

          if (soundOn && r.strong && now - lastBeepRef.current > 5000 && audioCtxRef.current) {
            lastBeepRef.current = now;
            try {
              const ctx = audioCtxRef.current;
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.type = "sine";
              osc.frequency.value = 880;
              osc.connect(gain);
              gain.connect(ctx.destination);
              gain.gain.setValueAtTime(0.0001, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.01);
              osc.start();
              setTimeout(() => {
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
                osc.stop(ctx.currentTime + 0.17);
              }, 120);
            } catch {}
          }
        });

        // impacts
        impactsRef.current = newImpacts;
        setImpacts(newImpacts);

        // Auto-summary (fires when meaningful change or new impact)
        maybeUpdateSummary(data, newImpacts);
      } catch {}
    };

    fetchData();
    timer = setInterval(fetchData, 2000);
    return () => clearInterval(timer);
  }, [soundOn]);

  // ---------- KPI metrics (last 10 impacts) ----------
  const last10 = impacts.slice(-10);
  const impactCount = last10.length;
  const avgImpact = impactCount
    ? (last10.reduce((s, i) => s + (i.retPct60s || 0), 0) / impactCount).toFixed(3)
    : "0.000";
  const winRate = impactCount
    ? Math.round((last10.filter((i) => (i.retPct60s || 0) > 0).length / impactCount) * 100)
    : 0;

  // ---------- helpers ----------
  const th = {
    borderBottom: "1px solid #2a3443",
    textAlign: "left",
    padding: "10px 8px",
    color: "#cbd5e1",
    fontWeight: 600,
    fontSize: 14,
  };
  const td = { borderBottom: "1px solid #1f2937", padding: "10px 8px", fontSize: 14, color: "#e5e7eb" };
  const age = (ts) => (ts ? ((Date.now() - ts) / 1000).toFixed(1) + "s" : "–");

  const selectedHist = useMemo(() => historyRef.current[selected] || [], [selected]);
  const selectedImpacts = useMemo(
    () => impacts.filter((ev) => ev.sym === selected),
    [impacts, selected]
  );

  const impactXs = selectedImpacts.map((ev) => new Date(ev.t));
  const impactYs = selectedImpacts.map((ev) => {
    const match = selectedHist.reduce((best, p) => {
      const d = Math.abs(p.t - ev.t);
      return d < (best?.d ?? Infinity) ? { d, g: p.g } : best;
    }, null);
    return match ? match.g : 0;
  });
  const impactTexts = selectedImpacts.map(
    (ev) => `${ev.retPct60s > 0 ? "+" : ""}${ev.retPct60s}%`
  );

  // ---------- Summary generator ----------
  function maybeUpdateSummary(newRows, newImpacts) {
    const prevRows = prevRowsRef.current;
    const prevImpactCount = prevImpactCountRef.current;

    const changed =
      hasMeaningfulMove(prevRows, newRows) ||
      newImpacts.length !== prevImpactCount;

    if (!changed) return;

    const text = buildSummary(newRows, newImpacts);
    setSummary({ text, ts: Date.now() });

    prevRowsRef.current = deepCopyRows(newRows);
    prevImpactCountRef.current = newImpacts.length;
  }

  function hasMeaningfulMove(prevRows, curRows) {
    if (!prevRows || !Array.isArray(prevRows) || prevRows.length === 0) return true;
    const bySymPrev = Object.fromEntries(prevRows.map((r) => [r.symbol, r]));
    for (const r of curRows) {
      const p = bySymPrev[r.symbol];
      if (!p) return true;
      // triggers: notable price Δ%, divergence shift, info surge
      const priceJump = Math.abs((r.priceDelta1mPct || 0) - (p.priceDelta1mPct || 0)) >= 0.02;
      const divShift = Math.abs((r.divergence || 0) - (p.divergence || 0)) >= 0.15;
      const infoSurge = (r.infoCount1m || 0) - (p.infoCount1m || 0) >= 3;
      if (priceJump || divShift || infoSurge) return true;
    }
    return false;
  }

  function buildSummary(curRows, curImpacts) {
    const lines = [];
    // Sort symbols for stable order
    const ordered = [...curRows].sort((a, b) => a.symbol.localeCompare(b.symbol));

    for (const r of ordered) {
      const price = r.lastPrice?.toLocaleString?.() ?? r.lastPrice;
      const pct = fmtPct(r.priceDelta1mPct);
      const div = r.divergence ?? 0;
      const divTone = div > 0.5 ? "elevated positive divergence" :
                      div < -0.5 ? "elevated negative divergence" :
                      div > 0.15 ? "mild positive divergence" :
                      div < -0.15 ? "mild negative divergence" :
                      "balanced";
      const infoVol = r.infoCount1m ?? 0;
      const energyInfo = r.energy?.energyPerTxKWh 
        ? ` Energy: ${fmt(r.energy.energyPerTxKWh, 2)} kWh/tx`
        : "";

      lines.push(
        `${r.symbol}: ${price} (${pct} last minute). Divergence ${fmt(div, 2)} → ${divTone}; ` +
        `info volume ${infoVol} in the last minute.${energyInfo}`
      );
    }

    // Latest impact (if any)
    const last = curImpacts.at(-1);
    if (last) {
      const direction = last.retPct60s > 0 ? "positive" : last.retPct60s < 0 ? "negative" : "flat";
      const energyImpact = last.energy?.totalEnergyCostKWh
        ? ` Energy cost: ${fmt(last.energy.totalEnergyCostKWh, 2)} kWh`
        : "";
      lines.push(
        `Impact detected: ${last.sym} zSent spike ${fmt(last.zSentAtSpike, 2)}; ` +
        `subsequent 60s return ${fmt(last.retPct60s, 3)}% (${direction}).${energyImpact}`
      );
    }

    // Bulls vs Bears score from last 10 impacts
    const l10 = curImpacts.slice(-10);
    if (l10.length > 0) {
      const bulls = l10.filter((i) => (i.retPct60s || 0) > 0).length;
      const bears = l10.filter((i) => (i.retPct60s || 0) < 0).length;
      const totalEnergy = l10.reduce((sum, i) => sum + (i.energy?.totalEnergyCostKWh || 0), 0);
      const energyNote = totalEnergy > 0 ? ` Total energy cost: ${fmt(totalEnergy, 2)} kWh` : "";
      lines.push(`Recent impact score (last 10): Bulls ${bulls} vs Bears ${bears}.${energyNote}`);
    }

    return lines.join(" ");
  }

  function fmt(n, dp = 2) {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return "0";
    return v.toFixed(dp);
  }
  function fmtPct(n) {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return "0%";
    const s = v >= 0 ? "+" : "";
    return `${s}${v.toFixed(3)}%`;
  }
  function deepCopyRows(rs) {
    return rs.map((r) => ({ ...r }));
  }

  return (
    <div style={{ background: "#0b1220", minHeight: "100vh", color: "#e5e7eb" }}>
      {/* Header */}
      <div style={{ padding: "20px 20px 8px 20px", display: "flex", alignItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 800, letterSpacing: 0.2, color: "#e5e7eb" }}>
          Micro-Market Pulse
        </h1>
        <div style={{ marginLeft: "auto" }}>
          <button
            onClick={toggleAudio}
            style={{
              background: soundOn ? "#1f4a2e" : "#1f2937",
              color: soundOn ? "#a7f3d0" : "#cbd5e1",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
            title="Toggle audio alerts for strong signals"
          >
            {soundOn ? "Audio Alerts: ON" : "Audio Alerts: OFF"}
          </button>
        </div>
      </div>

      <p style={{ margin: "0 20px 14px 20px", color: "#94a3b8", fontSize: 14 }}>
        Live fusion of Binance prices and real-time mentions. Click a row to focus its sparkline.
      </p>

      {/* KPIs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          padding: "0 20px 12px 20px",
        }}
      >
        <KPI title="Impacts (last 10)" value={impactCount} />
        <KPI title="Average Impact" value={`${avgImpact}%`} />
        <KPI title="Win Rate" value={`${winRate}%`} />
      </div>

      {/* Table */}
      <div style={{ padding: "0 20px" }}>
        <div style={{ overflow: "hidden", borderRadius: 10, border: "1px solid #1f2937", background: "#0e1726" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead style={{ background: "#0f1b2d" }}>
              <tr>
                <th style={th}>Symbol</th>
                <th style={th}>Last Price</th>
                <th style={th}>Price Δ% (1m)</th>
                <th style={th}>Sent Δ (1m)</th>
                <th style={th}>zSent</th>
                <th style={th}>zPrice</th>
                <th style={th}>Divergence</th>
                <th style={th}>Pred 1m</th>
                <th style={th}>Info Vol (1m)</th>
                <th style={th}>Energy/Tx</th>
                <th style={th}>Price Age</th>
                <th style={th}>Info Age</th>
                <th style={th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tint =
                  r.divergence > 1.5 ? "#16a34a" : r.divergence < -1.5 ? "#dc2626" : "#cbd5e1";
                const isSelected = r.symbol === selected;
                const bg = isSelected ? "rgba(59,130,246,0.10)" : "transparent";
                return (
                  <tr
                    key={r.symbol}
                    onClick={() => setSelected(r.symbol)}
                    style={{ cursor: "pointer", background: bg }}
                  >
                    <td style={td}>{r.symbol}</td>
                    <td style={td}>{r.lastPrice?.toLocaleString?.() ?? r.lastPrice}</td>
                    <td style={td}>{fmtPct(r.priceDelta1mPct)}</td>
                    <td style={td}>{r.sentDelta1m}</td>
                    <td style={td}>{r.zSent}</td>
                    <td style={td}>{r.zPrice}</td>
                    <td style={{ ...td, color: tint }}>{r.divergence}</td>
                    <td style={td}>
                      {r.predictedNextReturn !== undefined
                        ? (r.predictedNextReturn > 0 ? "+" : "") + r.predictedNextReturn
                        : "–"}
                    </td>
                    <td style={td}>{r.infoCount1m ?? 0}</td>
                    <td style={td}>
                      {r.energy?.energyPerTxKWh
                        ? `${r.energy.energyPerTxKWh.toFixed(2)} kWh`
                        : "–"}
                    </td>
                    <td style={td}>{age(r.lastPriceTs)}</td>
                    <td style={td}>{age(r.lastInfoTs)}</td>
                    <td style={td}>{new Date(r.updatedAt).toLocaleTimeString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Charts */}
      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Divergence Chart */}
        <div style={{ border: "1px solid #1f2937", borderRadius: 10, background: "#0e1726" }}>
          <Plot
            data={[
              {
                x: selectedHist.map((d) => new Date(d.t)),
                y: selectedHist.map((d) => d.g),
                type: "scatter",
                mode: "lines",
                name: `${selected} Divergence`,
                line: { color: "#60a5fa" },
              },
              {
                x: impactXs,
                y: impactYs,
                type: "scatter",
                mode: "markers+text",
                text: impactTexts,
                textposition: "top center",
                marker: { size: 10, color: "#fbbf24" },
                name: "Impacts",
              },
            ]}
            layout={{
              title: `${selected} Divergence (zSent - zPrice)`,
              paper_bgcolor: "#0e1726",
              plot_bgcolor: "#0e1726",
              font: { color: "#e5e7eb" },
              height: 320,
              margin: { l: 48, r: 16, t: 48, b: 48 },
            }}
            useResizeHandler
            style={{ width: "100%", height: "100%" }}
          />
        </div>

        {/* Price & Energy Correlation Chart */}
        {rows.length > 0 && energyData && (
          <div style={{ border: "1px solid #1f2937", borderRadius: 10, background: "#0e1726" }}>
            <Plot
              data={rows
                .filter((r) => r.symbol === selected && r.energy?.energyPerTxKWh)
                .map((r) => ({
                  x: [r.lastPrice],
                  y: [r.energy.energyPerTxKWh],
                  type: "scatter",
                  mode: "markers",
                  name: r.symbol,
                  marker: { size: 12, color: "#10b981" },
                }))}
              layout={{
                title: `${selected} Price vs Energy per Transaction`,
                xaxis: { title: "Price (USD)", color: "#e5e7eb" },
                yaxis: { title: "Energy (kWh/tx)", color: "#e5e7eb" },
                paper_bgcolor: "#0e1726",
                plot_bgcolor: "#0e1726",
                font: { color: "#e5e7eb" },
                height: 320,
                margin: { l: 60, r: 16, t: 48, b: 60 },
              }}
              useResizeHandler
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        )}
      </div>

      {/* Analytics Dashboard */}
      {analytics && (
        <div style={{ padding: "0 20px 12px 20px" }}>
          <div style={{ border: "1px solid #1f2937", borderRadius: 10, background: "#0e1726" }}>
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid #1f2937",
                fontWeight: 700,
                color: "#cbd5e1",
              }}
            >
              Unified Analytics (Price + Sentiment + Energy)
            </div>
            <div style={{ padding: "12px 14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
                <div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>Recent Impacts</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#e5e7eb" }}>
                    {analytics.recentImpacts?.count || 0}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>Total Energy Cost</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#fbbf24" }}>
                    {analytics.recentImpacts?.totalEnergyCostKWh || 0} kWh
                  </div>
                </div>
                <div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>Total Carbon Cost</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#ef4444" }}>
                    {analytics.recentImpacts?.totalCarbonCostKg || 0} kg
                  </div>
                </div>
                <div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>Avg Price Change</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#e5e7eb" }}>
                    {fmt(analytics.recentImpacts?.avgPriceChange || 0, 3)}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Impact Feed */}
      <div style={{ padding: "0 20px 12px 20px" }}>
        <div style={{ border: "1px solid #1f2937", borderRadius: 10, background: "#0e1726" }}>
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid #1f2937",
              fontWeight: 700,
              color: "#cbd5e1",
            }}
          >
            Recent Impacts (info spike → 60s price move)
          </div>
        </div>
        <div style={{ border: "1px solid #1f2937", borderTop: "none", borderRadius: "0 0 10px 10px", background: "#0e1726", padding: "12px 14px" }}>
          {impacts.length === 0 ? (
            <div style={{ color: "#94a3b8" }}>No impacts observed yet.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {impacts
                .slice()
                .reverse()
                .map((ev, i) => (
                  <li key={i} style={{ marginBottom: 6, color: "#e5e7eb" }}>
                    <span style={{ color: "#94a3b8" }}>
                      {new Date(ev.t).toLocaleTimeString()} — {ev.sym}
                    </span>
                    {" · "}
                    <span>zSent at spike: {ev.zSentAtSpike}</span>
                    {" · "}
                    <span
                      style={{
                        color:
                          ev.retPct60s > 0 ? "#16a34a" : ev.retPct60s < 0 ? "#dc2626" : "#e5e7eb",
                      }}
                    >
                      60s return: {(ev.retPct60s > 0 ? "+" : "") + ev.retPct60s}%
                    </span>
                    {ev.energy?.totalEnergyCostKWh && (
                      <>
                        {" · "}
                        <span style={{ color: "#fbbf24" }}>
                          Energy: {ev.energy.totalEnergyCostKWh.toFixed(2)} kWh
                        </span>
                      </>
                    )}
                    {ev.energy?.totalCarbonCostKg && (
                      <>
                        {" · "}
                        <span style={{ color: "#94a3b8", fontSize: 12 }}>
                          CO₂: {ev.energy.totalCarbonCostKg.toFixed(2)} kg
                        </span>
                      </>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>

      {/* Energy Consumption Section */}
      {energyData && energyData.BTC && (
        <div style={{ padding: "0 20px 24px 20px" }}>
          <div style={{ border: "1px solid #1f2937", borderRadius: 10, background: "#0e1726" }}>
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid #1f2937",
                fontWeight: 700,
                color: "#cbd5e1",
              }}
            >
              Bitcoin Energy Consumption{" "}
              <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8" }}>
                (Source:{" "}
                <a
                  href="https://digiconomist.net/bitcoin-energy-consumption"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#60a5fa" }}
                >
                  Digiconomist
                </a>
                )
              </span>
            </div>
            <div style={{ padding: "12px 14px" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 16,
                  marginBottom: 16,
                }}
              >
                <div>
                  <h3 style={{ margin: "0 0 8px 0", fontSize: 14, color: "#94a3b8" }}>
                    Annualized Footprints
                  </h3>
                  <div style={{ fontSize: 13, color: "#e5e7eb", lineHeight: 1.8 }}>
                    <div>
                      🌍 Carbon:{" "}
                      <strong>
                        {energyData.BTC.annualized?.carbonFootprintMtCO2
                          ? energyData.BTC.annualized.carbonFootprintMtCO2.toFixed(2)
                          : "N/A"}{" "}
                        Mt CO₂
                      </strong>
                    </div>
                    <div>
                      ⚡ Energy:{" "}
                      <strong>
                        {energyData.BTC.annualized?.electricalEnergyTWh
                          ? energyData.BTC.annualized.electricalEnergyTWh.toFixed(2)
                          : "N/A"}{" "}
                        TWh
                      </strong>
                    </div>
                    <div>
                      🗑️ E-Waste:{" "}
                      <strong>
                        {energyData.BTC.annualized?.electronicWasteKt
                          ? energyData.BTC.annualized.electronicWasteKt.toFixed(2)
                          : "N/A"}{" "}
                        kt
                      </strong>
                    </div>
                    <div>
                      💧 Water:{" "}
                      <strong>
                        {energyData.BTC.annualized?.freshWaterConsumptionGL
                          ? energyData.BTC.annualized.freshWaterConsumptionGL.toFixed(0)
                          : "N/A"}{" "}
                        GL
                      </strong>
                    </div>
                  </div>
                </div>
                <div>
                  <h3 style={{ margin: "0 0 8px 0", fontSize: 14, color: "#94a3b8" }}>
                    Per Transaction
                  </h3>
                  <div style={{ fontSize: 13, color: "#e5e7eb", lineHeight: 1.8 }}>
                    <div>
                      🌍 Carbon:{" "}
                      <strong>
                        {energyData.BTC.perTransaction?.carbonFootprintKgCO2
                          ? energyData.BTC.perTransaction.carbonFootprintKgCO2.toFixed(2)
                          : "N/A"}{" "}
                        kg CO₂
                      </strong>
                    </div>
                    <div>
                      ⚡ Energy:{" "}
                      <strong>
                        {energyData.BTC.perTransaction?.electricalEnergyKWh
                          ? energyData.BTC.perTransaction.electricalEnergyKWh.toFixed(2)
                          : "N/A"}{" "}
                        kWh
                      </strong>
                    </div>
                    <div>
                      🗑️ E-Waste:{" "}
                      <strong>
                        {energyData.BTC.perTransaction?.electronicWasteGrams
                          ? energyData.BTC.perTransaction.electronicWasteGrams.toFixed(2)
                          : "N/A"}{" "}
                        g
                      </strong>
                    </div>
                    <div>
                      💧 Water:{" "}
                      <strong>
                        {energyData.BTC.perTransaction?.freshWaterConsumptionLiters
                          ? energyData.BTC.perTransaction.freshWaterConsumptionLiters.toFixed(0)
                          : "N/A"}{" "}
                        L
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#94a3b8",
                  borderTop: "1px solid #1f2937",
                  paddingTop: 8,
                }}
              >
                Updated:{" "}
                {energyData.BTC.updatedAt
                  ? new Date(energyData.BTC.updatedAt).toLocaleString()
                  : "N/A"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto Summary */}
      <div style={{ padding: "0 20px 24px 20px" }}>
        <div style={{ border: "1px solid #1f2937", borderRadius: 10, background: "#0e1726" }}>
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid #1f2937",
              fontWeight: 700,
              color: "#cbd5e1",
            }}
          >
            Auto Summary
          </div>
          <div style={{ padding: "12px 14px", color: "#e5e7eb", lineHeight: 1.5 }}>
            <div style={{ marginBottom: 6 }}>{summary.text}</div>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              Updated {new Date(summary.ts).toLocaleTimeString()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small KPI card */
function KPI({ title, value }) {
  return (
    <div
      style={{
        background: "#0e1726",
        border: "1px solid #1f2937",
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div style={{ color: "#94a3b8", fontSize: 12, letterSpacing: 0.3 }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 22, fontWeight: 800, color: "#e5e7eb" }}>{value}</div>
    </div>
  );
}
