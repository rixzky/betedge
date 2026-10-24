import { useMemo, useState } from "react";
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import type { Meta, PolicySummary } from "../../../../contract/api_types";
import { api, useApi } from "../api";
import { Empty, ErrorBox, Loading, Notes, Panel, ScreenHead, Seg } from "../components/ui";
import { MODEL_LABEL } from "../config";
import { day, fix, int, isNum, spct, sunits, units } from "../format";
import { setParams } from "../route";
import type { EvidenceX, Mode } from "../types";

const COLORS: Record<string, string> = {
  market: "#8FA3BF", elo: "#F59E4B", dixon_coles: "#B48CF5", marketnet: "#3DDC97", lgbm: "#3FD0E0",
  controlled: "#bce5bb", controlled_best_price: "#ddebab", naive: "#d9b282",
};
const color = (k: string) => COLORS[k] ?? "#EEF3FA";
const axis = { stroke: "#5B7395", fontSize: 12, fontFamily: "IBM Plex Mono, monospace" };
const tip = { contentStyle: { background: "#0B1A30", border: "1px solid #2A4468", borderRadius: 6, fontSize: 12 }, labelStyle: { color: "#B8C6DA" } };

export function EvidenceScreen({ meta, params, mode: viewMode = "advanced" }: { meta: Meta; params: URLSearchParams; mode?: Mode }) {
  const split = params.get("split") ?? "validation";
  const model = params.get("model") ?? "";
  const ev = useApi<EvidenceX>(() => api.evidence(model || undefined, split), [model, split]);
  const set = (p: Record<string, string | undefined>) => setParams("evidence", { split, model, ...p });
  const d = ev.data;
  const locked = !!d?.is_locked_holdout;

  return (
    <div className="screen">
      <ScreenHead
        kicker="03 · Evidence"
        title={locked ? "The locked holdout" : "Did the edge hold up?"}
        lede="Forecast accuracy and betting returns are reported separately, on the same matches for every model. Turnover sits next to every return: staking less is not success on its own."
        right={
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Seg label="Split" value={split} onChange={(s) => set({ split: s, model: undefined })}
              options={[
                ...(viewMode === "advanced" ? [{ value: "calibration", label: "Calibration" }] : []),
                { value: "validation", label: "Validation" },
                { value: "holdout", label: meta.holdout_locked ? "Holdout · locked" : "Holdout", disabled: !meta.holdout_locked,
                  title: meta.holdout_locked ? undefined : "Hidden until holdout_locked.json exists" },
              ]} />
            {d && !locked && (d.x_models?.length ?? 0) > 0 && (
              <Seg label="Model" value={d.model_id} onChange={(m) => set({ model: m })}
                options={(d.x_models ?? []).map((m) => ({ value: m, label: MODEL_LABEL[m] ?? m }))} />
            )}
          </div>
        }
        tone={locked ? "amber" : undefined}
      />
      {ev.error && <ErrorBox error={ev.error} />}
      {!d && !ev.error && <Loading what="evidence" />}
      {d && (
        <div className="grid">
          {locked ? (
            <div className="exploratory" style={{ borderStyle: "solid", marginBottom: 0 }}>
              <b>LOCKED HOLDOUT</b>
              <span>Evaluated once with the frozen configuration. Model {d.model_id}{d.x_model_version ? ` · ${d.x_model_version}` : ""}.</span>
              <span className="chip amber">config {d.x_config_hash ?? "n/a"}</span>
              <span className="chip">locked {d.x_locked_at_utc ? day(d.x_locked_at_utc) : "n/a"}</span>
            </div>
          ) : (
            <div className="note">
              {split === "validation" ? "Validation season: used to choose models and thresholds, so it is not an out-of-sample test." : `Split: ${split}.`}
              {d.model_id && <> Policy results below are for <b>{MODEL_LABEL[d.model_id] ?? d.model_id}</b>.</>}
            </div>
          )}
          <Notes notes={d.x_notes} />
          <div className="row">
            <Panel title="Forecast accuracy" sub="Same matches for every model · lower is better" style={{ flex: "1 1 420px" }}>
              <ForecastTable d={d} />
            </Panel>
            {viewMode === "advanced" && (
              <Panel title="Calibration" sub="Pooled H/D/A probabilities, 10 bins · dot size = matches in bin" style={{ flex: "1 1 460px" }}>
                <Calibration key={`${d.split}-${d.model_id}`} d={d} />
              </Panel>
            )}
          </div>
          <Panel title="Paper-betting results" sub="Naive Bet365 · controlled Bet365 · controlled best valid price">
            <Policies policies={d.policies} viewMode={viewMode} />
          </Panel>
          {viewMode === "advanced" && (
            <Panel title="Line-shopping comparison" sub="Controlled best price versus controlled Bet365, as supplied by the evaluation artifact">
              {d.x_line_shopping ? <div className="artifact-comparison"><dl className="kv">
                {Object.entries(d.x_line_shopping).map(([key, value]) => <div className="comparison-field" key={key}>
                  <dt>{key.replace(/_/g, " ")}</dt><dd className="mono">{value === null || value === undefined ? "n/a" : typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>)}
              </dl></div> : <Empty>n/a · The paired comparison has not arrived in policy_metrics.json. Forecast metrics above remain available.</Empty>}
              <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>best-of-many prices are biased upwards by stale quotes</p>
            </Panel>
          )}
          <div className="row">
            <Panel title="Equity and drawdown" sub="Settled paper bankroll per batch, 1000 units at the start" style={{ flex: "2 1 620px" }}>
              <Equity d={d} />
            </Panel>
            {viewMode === "advanced" && (
              <Panel title="Feature importance" sub="What the ML models lean on (Part 2)" style={{ flex: "1 1 360px" }}>
                <Importance key={`${d.split}-${d.model_id}`} d={d} />
              </Panel>
            )}
          </div>
          <Panel title="Limitations" tone="amber">
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {d.limitations.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}

function ForecastTable({ d }: { d: EvidenceX }) {
  if (!d.forecast.length) return <Empty>No forecast metrics for this split yet (Part 2: forecast_metrics.json).</Empty>;
  const rows = [...d.forecast].sort((a, b) => (isNum(a.log_loss) ? a.log_loss : Infinity) - (isNum(b.log_loss) ? b.log_loss : Infinity));
  return (
    <div className="scroll-x">
      <table className="data">
        <thead><tr><th>Model</th><th className="n">Matches</th><th className="n">Log loss</th><th className="n">Brier (sum over 3 outcomes)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model_id} className={r.model_id === d.model_id ? "hl" : ""}>
              <td>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color(r.model_id), marginRight: 8 }} />
                {MODEL_LABEL[r.model_id] ?? r.model_id}
                {r.model_id === "market" && <span className="chip" style={{ marginLeft: 8 }}>baseline</span>}
              </td>
              <td className="n">{int(r.n)}</td>
              <td className="n">{fix(r.log_loss, 4)}</td>
              <td className="n">{fix(r.brier_sum3, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>{d.x_brier_convention ? `Brier convention: ${d.x_brier_convention}.` : null} Sorted by log loss. If no model beats the market here, that is the finding.</p>
    </div>
  );
}

function Calibration({ d }: { d: EvidenceX }) {
  const models = d.forecast.map((f) => f.model_id);
  const [on, setOn] = useState<string[]>(() => models.filter((m) => m === "market" || m === d.model_id || models.length <= 3));
  if (!d.forecast.length) return <Empty>No calibration bins yet.</Empty>;
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {models.map((m) => (
          <button key={m} type="button" className="chip" aria-pressed={on.includes(m)}
            style={{ cursor: "pointer", borderColor: on.includes(m) ? color(m) : undefined, color: on.includes(m) ? color(m) : undefined }}
            onClick={() => setOn(on.includes(m) ? on.filter((x) => x !== m) : [...on, m])}>
            {MODEL_LABEL[m] ?? m}
          </button>
        ))}
      </div>
      <div style={{ height: 300 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 4 }}>
            <CartesianGrid stroke="#1E3556" />
            <XAxis type="number" dataKey="mean_pred" domain={[0, 1]} tick={axis} stroke={axis.stroke}
              tickFormatter={(v) => `${Math.round(v * 100)}%`} label={{ value: "forecast probability", position: "bottom", fill: "#8195B2", fontSize: 12 }} />
            <YAxis type="number" dataKey="obs_freq" domain={[0, 1]} tick={axis} stroke={axis.stroke}
              tickFormatter={(v) => `${Math.round(v * 100)}%`} label={{ value: "observed", angle: -90, position: "insideLeft", fill: "#8195B2", fontSize: 12 }} />
            <ZAxis type="number" dataKey="n" range={[30, 380]} />
            <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#5B7395" strokeDasharray="5 5" />
            <Tooltip {...tip} cursor={{ strokeDasharray: "3 3" }}
              formatter={(v: number, name: string) => (name === "n" ? int(v) : `${(v * 100).toFixed(1)}%`)} />
            {d.forecast.filter((f) => on.includes(f.model_id)).map((f) => (
              <Scatter key={f.model_id} name={MODEL_LABEL[f.model_id] ?? f.model_id} data={f.calibration_bins}
                fill={color(f.model_id)} fillOpacity={0.75} line={{ stroke: color(f.model_id), strokeOpacity: 0.5 }} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="dim" style={{ fontSize: 12, margin: 0 }}>Points on the dashed line are perfectly calibrated. Above it: outcomes happened more often than forecast.</p>
    </div>
  );
}

function ci(p: PolicySummary) {
  const r = p.bootstrap_ci_95?.roi;
  if (!r || !isNum(r[0]) || !isNum(r[1])) return "n/a";
  return `${spct(r[0])} to ${spct(r[1])}`;
}

function Policies({ policies, viewMode = "advanced" }: { policies: PolicySummary[]; viewMode?: Mode }) {
  if (!policies.length) return <Empty>No policy metrics for this model and split yet (Part 2: policy_metrics.json).</Empty>;
  const allLines: [string, (p: PolicySummary) => string, boolean][] = [
    ["Decisions looked at", (p) => int(p.n_decisions), false],
    ["Bets placed", (p) => int(p.n_bets), false],
    ["Abstentions", (p) => int(p.n_abstain), true],
    ["Total staked", (p) => units(p.turnover), false],
    ["Profit / loss", (p) => sunits(p.profit), false],
    ["Return on investment", (p) => spct(p.roi), false],
    ["ROI 95% CI (matchweek bootstrap)", ci, true],
    ["Biggest drawdown", (p) => units(p.max_drawdown), false],
    ["Mean CLV", (p) => spct(p.mean_clv, 2), true],
    ["Sharpe per matchweek", (p) => fix(p.sharpe_per_matchweek, 3), true],
    ["Deflated Sharpe", (p) => fix(p.deflated_sharpe, 3), true],
  ];
  const lines = allLines.filter(([, , advancedOnly]) => viewMode === "advanced" || !advancedOnly).map(([k, f]) => [k, f] as [string, (p: PolicySummary) => string]);
  const ordered = [...policies].sort((a, b) => (a.policy_id === "naive" ? -1 : b.policy_id === "naive" ? 1 : 0));
  return (
    <div className="row">
      <div className="scroll-x" style={{ flex: "2 1 560px" }}>
        <table className="data">
          <thead>
            <tr><th />{ordered.map((p) => (
              <th key={p.policy_id} className="n" style={{ color: color(p.policy_id) }}>{p.policy_id}<div className="dim" style={{ font: "500 11px var(--font-b)", letterSpacing: 0, textTransform: "none", whiteSpace: "normal" }}>{p.label}</div></th>
            ))}</tr>
          </thead>
          <tbody>
            {lines.map(([k, f]) => (
              <tr key={k} className={k === "ROI" || k === "Turnover" ? "hl" : ""}><td>{k}</td>{ordered.map((p) => <td key={p.policy_id} className="n">{f(p)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ flex: "1 1 300px", display: "grid", gap: 12, alignContent: "start" }}>
        {ordered.map((p) => {
          const entries = Object.entries(p.reason_counts ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
          const total = entries.reduce((s, [, v]) => s + (v ?? 0), 0) || 1;
          return (
            <div key={p.policy_id}>
              <div className="label" style={{ color: color(p.policy_id) }}>{p.policy_id} · decision reasons</div>
              {entries.map(([code, n]) => (
                <div key={code} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 54px", gap: 8, alignItems: "center", fontSize: 12, marginTop: 4 }}>
                  <div>
                    <div className="mono" style={{ color: code === "ACCEPTED" ? "var(--green)" : "var(--muted)" }}>{code}</div>
                    <div className="bar"><i style={{ width: `${((n ?? 0) / total) * 100}%`, background: code === "ACCEPTED" ? "var(--green)" : color(p.policy_id) }} /></div>
                  </div>
                  <span className="mono" style={{ textAlign: "right" }}>{int(n)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Equity({ d }: { d: EvidenceX }) {
  const series = useMemo(() => {
    const by: Record<string, { t: number; bankroll: number; drawdown: number; batch: string }[]> = {};
    for (const p of d.equity_curve) {
      (by[p.policy_id] ??= []).push({ t: Date.parse(p.time_utc), bankroll: p.bankroll, drawdown: -p.drawdown, batch: p.batch_key });
    }
    for (const k of Object.keys(by)) by[k].sort((a, b) => a.t - b.t);
    return by;
  }, [d.equity_curve]);
  const keys = Object.keys(series);
  if (!keys.length) return <Empty>No equity curve yet.</Empty>;
  const fmtT = (t: number) => day(new Date(t).toISOString());
  return (
    <div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <LineChart margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="#1E3556" />
            <XAxis type="number" dataKey="t" domain={["dataMin", "dataMax"]} tick={axis} stroke={axis.stroke} tickFormatter={fmtT} allowDuplicatedCategory={false} />
            <YAxis tick={axis} stroke={axis.stroke} domain={["auto", "auto"]} />
            <ReferenceLine y={1000} stroke="#5B7395" strokeDasharray="4 4" />
            <Tooltip {...tip} labelFormatter={(t: number) => fmtT(t)} formatter={(v: number) => units(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {keys.map((k) => <Line key={k} data={series[k]} dataKey="bankroll" name={`${k} bankroll`} stroke={color(k)} dot={false} strokeWidth={2} type="stepAfter" isAnimationActive />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ height: 120 }}>
        <ResponsiveContainer>
          <AreaChart margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="#1E3556" />
            <XAxis type="number" dataKey="t" domain={["dataMin", "dataMax"]} tick={axis} stroke={axis.stroke} tickFormatter={fmtT} allowDuplicatedCategory={false} />
            <YAxis tick={axis} stroke={axis.stroke} />
            <Tooltip {...tip} labelFormatter={(t: number) => fmtT(t)} formatter={(v: number) => units(-v)} />
            {keys.map((k) => <Area key={k} data={series[k]} dataKey="drawdown" name={`${k} drawdown`} stroke={color(k)} fill={color(k)} fillOpacity={0.15} type="stepAfter" />)}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="dim" style={{ fontSize: 12, margin: 0 }}>Top: settled bankroll. Bottom: drawdown from the running peak (units below zero).</p>
    </div>
  );
}

function Importance({ d }: { d: EvidenceX }) {
  if (!d.feature_importance.length) return <Empty>No feature importance yet (Part 2: feature_importance.json).</Empty>;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {d.feature_importance.map((fi) => {
        const max = Math.max(...fi.features.map((f) => f.importance), 1e-12);
        return (
          <div key={`${fi.model_id}-${fi.method}`}>
            <div className="label" style={{ color: color(fi.model_id) }}>{MODEL_LABEL[fi.model_id] ?? fi.model_id} · {fi.method.replace(/_/g, " ")} · {fi.split}</div>
            {fi.features.map((f) => (
              <div key={f.feature} className="feat-row" style={{ gridTemplateColumns: "minmax(0, 150px) minmax(0, 1fr) 64px" }}>
                <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.feature}>{f.feature}</span>
                <div className="feat-bar"><i style={{ left: 0, width: `${(f.importance / max) * 100}%`, background: color(fi.model_id) }} /></div>
                <span className="mono" style={{ textAlign: "right" }}>{fix(f.importance, 4)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
