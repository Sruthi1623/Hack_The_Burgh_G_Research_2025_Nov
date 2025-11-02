import { useEffect, useMemo, useRef, useState } from "react";
import Plot from "react-plotly.js";

export default function App() {
  // --- state / refs ---
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState("BTC");
  const [soundOn, setSoundOn] = useState(false);

  const [impacts, setImpacts] = useState([]);
  const impactsRef = useRef([]); // track previous impacts to detect new ones

  const historyRef = useRef({ BTC: [], ETH: [] }); // divergence history for sparkline
  const audioCtxRef = useRef(null);
  const lastBeepRef = useRef(0);

  const [toast, setToast] = useState(null); // { msg, ts }

  const initAudio = () => {
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    }
    setSoundOn(true);
  };

  // --- data polling ---
  useEffect(() => {
    let timer;

    const fetchData = async () => {
      try {
        const res = await fetch("/signals");
        if (!res.ok) return;

        const text = await res.text();
        if (!text) return;

        const json = JSON.parse(text);
        const data = Array.isArray(json.data) ? json.data : [];
        const newImpacts = Array.isArray(json.impacts) ? json.impacts : [];

        // update rows
        setRows(data);

        // update divergence history + strong beeps
        const h = historyRef.current;
        const now = Date.now();

        data.forEach((r) => {
          const arr = h[r.symbol] || [];
          arr.push({ t: now, g: r.divergence ?? 0 });
          if (arr.length > 150) arr.shift();
          h[r.symbol] = arr;

          // strong signal beep (cooldown 5s)
          if (soundOn && r.strong && now - lastBeepRef.current > 5000 && audioCtxRef.current) {
            lastBeepRef.current = now;
            try {
              const ctx = audioCtxRef.current;
              const o = ctx.createOscillator();
              const g = ctx.createGain();
              o.type = "sine";
              o.frequency.value = 880;
              o.connect(g);
              g.connect(ctx.destination);
              g.gain.setValueAtTime(0.0001, ctx.currentTime);
              g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.01);
              o.start();
              setTimeout(() => {
                g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
                o.stop(ctx.currentTime + 0.17);
              }, 120);
            } catch {}
          }
        });

        // detect newly arrived impacts → toast + short beep
        const prev = impactsRef.current;
        if (newImpacts.length > prev.length) {
          const newly = newImpacts.slice(prev.length);
          const last = newly[newly.length - 1];
          setToast({
            msg: `${last.sym} info spike → ${
              last.retPct60s > 0 ? "▲" : last.retPct60s < 0 ? "▼" : "→"
            } ${last.retPct60s}%`,
            ts: now,
          });

          if (soundOn && audioCtxRef.current) {
            try {
              const ctx = audioCtxRef.current;
              const o = ctx.createOscillator();
              const g = ctx.createGain();
              o.type = "triangle";
              o.frequency.value = 660;
              o.connect(g);
              g.connect(ctx.destination);
              g.gain.setValueAtTime(0.0001, ctx.currentTime);
              g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.01);
              o.start();
              setTimeout(() => {
                g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
                o.stop(ctx.currentTime + 0.22);
              }, 160);
            } catch {}
          }
        }
        impactsRef.current = newImpacts;
        setImpacts(newImpacts);
      } catch {}
    };

    fetchData();
    timer = setInterval(fetchData, 2000);
    return () => clearInterval(timer);
  }, [soundOn]);

  // auto-hide toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- helpers ---
  const th = { borderBottom: "1px solid #e5e7eb", textAlign: "left", padding: "8px" };
  const td = { borderBottom: "1px solid #1f2937", padding: "8px" };
  const age = (ts) => (ts ? ((Date.now() - ts) / 1000).toFixed(1) + "s" : "–");

  const selectedHist = useMemo(() => historyRef.current[selected] || [], [selected]);
  const selectedImpacts = useMemo(
    () => impacts.filter((ev) => ev.sym === selected),
    [impacts, selected]
  );

  // map impact time to closest divergence value for marker Y; fallback 0
  const impactXs = selectedImpacts.map((ev) => new Date(ev.t));
  const impactYs = selectedImpacts.map((ev) => {
    const match = selectedHist.reduce((best, p) => {
      const d = Math.abs(p.t - ev.t);
      return d < (best?.d ?? Infinity) ? { d, g: p.g } : best;
    }, null);
    return match ? match.g : 0;
  });
  const impactTexts = selectedImpacts.map((ev) =>
    `${ev.retPct60s > 0 ? "▲" : ev.retPct60s < 0 ? "▼" : "→"} ${ev.retPct60s}%`
  );

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "ui-sans-serif, system-ui",
        color: "#e5e7eb",
        background: "#111827",
        minHeight: "100vh",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ marginBottom: 8, marginRight: 12 }}>Micro-Market Pulse</h1>
        <button
          onClick={initAudio}
          style={{
            background: soundOn ? "#16a34a" : "#374151",
            color: "white",
            border: "none",
            borderRadius: 8,
            padding: "6px 10px",
            cursor: "pointer",
          }}
          title="Enable audio alerts (browser requires a user gesture)"
        >
          {soundOn ? "Sound: ON" : "Enable Sound"}
        </button>
      </div>

      <p style={{ color: "#9ca3af", marginTop: 0 }}>
        Live fusion of Binance prices and headlines/mentions. Click a row to focus its sparkline.
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%", background: "#0b1220" }}>
        <thead>
          <tr>
            <th style={th}>Symbol</th>
            <th style={th}>Last Price</th>
            <th style={th}>Price Δ% (1m)</th>
            <th style={th}>Sent Δ (1m)</th>
            <th style={th}>zSent</th>
            <th style={th}>zPrice</th>
            <th style={th}>Divergence</th>
            <th style={th}>Pred 1m (toy)</th>
            <th style={th}>Info Vol (1m)</th>
            <th style={th}>Price Age</th>
            <th style={th}>Info Age</th>
            <th style={th}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color =
              r.divergence > 1.5 ? "#16a34a" : r.divergence < -1.5 ? "#dc2626" : "#e5e7eb";
            const rowBg = r.strong ? "rgba(22,163,74,0.08)" : "transparent";
            const isSelected = r.symbol === selected;
            const arrow =
              r.predictedNextReturn > 0
                ? "↑"
                : r.predictedNextReturn < 0
                ? "↓"
                : "→";

            // flash row for ~10s if an impact for this symbol just landed
            const recentImpact = impacts.find(
              (ev) => ev.sym === r.symbol && Date.now() - ev.t < 10_000
            );
            const baseBg = isSelected ? "rgba(59,130,246,0.08)" : rowBg;
            const flashBg = recentImpact ? "rgba(234,179,8,0.12)" : baseBg;

            return (
              <tr
                key={r.symbol}
                onClick={() => setSelected(r.symbol)}
                style={{ cursor: "pointer", background: flashBg }}
              >
                <td style={td}>{r.symbol}</td>
                <td style={td}>{r.lastPrice?.toLocaleString?.() ?? r.lastPrice}</td>
                <td style={td}>{r.priceDelta1mPct}</td>
                <td style={td}>{r.sentDelta1m}</td>
                <td style={td}>{r.zSent}</td>
                <td style={td}>{r.zPrice}</td>
                <td style={{ ...td, color }}>{r.divergence}</td>
                <td style={td}>
                  {r.predictedNextReturn !== undefined ? (
                    <span title={r.predictedNextReturn}>
                      {arrow} {r.predictedNextReturn}
                    </span>
                  ) : (
                    "–"
                  )}
                </td>
                <td style={td}>{r.infoCount1m ?? 0}</td>
                <td style={td}>{age(r.lastPriceTs)}</td>
                <td style={td}>{age(r.lastInfoTs)}</td>
                <td style={td}>{new Date(r.updatedAt).toLocaleTimeString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Divergence sparkline + impact markers */}
      <div style={{ marginTop: 20 }}>
        <Plot
          data={[
            {
              x: selectedHist.map((d) => new Date(d.t)),
              y: selectedHist.map((d) => d.g),
              type: "scatter",
              mode: "lines",
              name: `${selected} Divergence`,
            },
            {
              x: impactXs,
              y: impactYs,
              type: "scatter",
              mode: "markers+text",
              text: impactTexts,
              textposition: "top center",
              marker: { size: 8 },
              name: "Impacts",
            },
          ]}
          layout={{
            title: `${selected} Divergence (zSent - zPrice)`,
            paper_bgcolor: "#111827",
            plot_bgcolor: "#111827",
            font: { color: "#e5e7eb" },
            height: 280,
            margin: { l: 40, r: 10, t: 40, b: 40 },
          }}
          useResizeHandler
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      {/* Impact feed panel */}
      <div style={{ marginTop: 16, background: "#0b1220", padding: 12, borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Recent “Info → Price” linkages (60s window)
        </div>
        {impacts.length === 0 ? (
          <div style={{ color: "#9ca3af" }}>No measured impacts yet…</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {impacts
              .slice()
              .reverse()
              .map((ev, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <span style={{ color: "#9ca3af" }}>
                    {new Date(ev.t).toLocaleTimeString()} — {ev.sym} info spike (z=
                    {ev.zSentAtSpike})
                  </span>
                  {" → "}
                  <span
                    style={{
                      color:
                        ev.retPct60s > 0
                          ? "#16a34a"
                          : ev.retPct60s < 0
                          ? "#dc2626"
                          : "#e5e7eb",
                    }}
                  >
                    {ev.retPct60s > 0 ? "▲" : ev.retPct60s < 0 ? "▼" : "→"} {ev.retPct60s}%
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            background: "#0b1220",
            color: "#e5e7eb",
            border: "1px solid #1f2937",
            borderRadius: 10,
            padding: "10px 14px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
            zIndex: 1000,
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
