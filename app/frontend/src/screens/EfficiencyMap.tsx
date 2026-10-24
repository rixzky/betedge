import { useEffect, useMemo, useState } from "react";
import type { EfficiencyMap, EfficiencyRow, Meta } from "../../../../contract/api_types";
import { api, useApi } from "../api";
import { ErrorBox, Loading, Panel, ScreenHead, Seg } from "../components/ui";
import { LEAGUE_LABEL } from "../config";
import { fix, int, isNum, pct, spp } from "../format";
import { go } from "../route";

type Metric = "log_loss" | "calib_slope" | "fav_longshot_gap" | "draw_bias" | "mean_overround";

const METRICS: { id: Metric; label: string; kind: "seq" | "div"; center?: number; fmt: (v: number | null) => string; help: string }[] = [
  { id: "log_loss", label: "Log loss", kind: "seq", fmt: (v) => fix(v, 3), help: "Mean log loss of the margin-free market probabilities. Lower = sharper, better-calibrated prices." },
  { id: "calib_slope", label: "Calibration slope", kind: "div", center: 1, fmt: (v) => fix(v, 2), help: "Logistic recalibration slope of the market probabilities." },
  { id: "fav_longshot_gap", label: "Favourite-longshot gap", kind: "div", center: 0, fmt: (v) => spp(v), help: "Mean(outcome − q) for longshots (q < 0.25) minus the same for favourites (q > 0.6)." },
  { id: "draw_bias", label: "Draw bias", kind: "div", center: 0, fmt: (v) => spp(v), help: "Mean(draw happened − q_draw)." },
  { id: "mean_overround", label: "Overround", kind: "seq", fmt: (v) => pct(v, 2), help: "Mean bookmaker margin: Σ 1/O − 1." },
];

const LEAGUE_ORDER = ["E0", "E1", "SP1", "D1", "I1", "F1", "N1", "P1"];

function mix(a: number[], b: number[], t: number) {
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}
const NEUTRAL = [16, 34, 64];
const BLUE = [64, 132, 235];
const ORANGE = [240, 146, 60];
const CYAN = [40, 190, 210];

/** Colour only rescales the numbers shown; it computes nothing new. */
function colourFor(m: (typeof METRICS)[number], v: number | null, lo: number, hi: number) {
  if (!isNum(v)) return undefined;
  if (m.kind === "seq") {
    const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
    return mix(NEUTRAL, CYAN, 0.15 + 0.85 * t);
  }
  const c = m.center ?? 0;
  const span = Math.max(Math.abs(hi - c), Math.abs(lo - c), 1e-9);
  const t = (v - c) / span;
  return t >= 0 ? mix(NEUTRAL, ORANGE, Math.min(1, t)) : mix(NEUTRAL, BLUE, Math.min(1, -t));
}

export function EfficiencyMapScreen({ meta }: { meta: Meta }) {
  const eff = useApi<EfficiencyMap>(() => api.efficiencyMap(), []);
  const [metric, setMetric] = useState<Metric>("log_loss");
  const [snapshot, setSnapshot] = useState<"PRE_CLOSING" | "CLOSING">("PRE_CLOSING");
  const [book, setBook] = useState<string>("B365");
  const [sel, setSel] = useState<EfficiencyRow | null>(null);

  const m = METRICS.find((x) => x.id === metric)!;
  const rows = eff.data?.rows ?? [];
  const books = useMemo(() => Array.from(new Set(rows.map((r) => r.bookmaker))).sort(), [rows]);
  useEffect(() => { if (books.length && !books.includes(book)) setBook(books.includes("B365") ? "B365" : books[0]); }, [books, book]);
  useEffect(() => setSel(null), [book, snapshot, metric]);
  const shown = rows.filter((r) => r.snapshot === snapshot && r.bookmaker === book);
  const leagues = Array.from(new Set(rows.map((r) => r.league))).sort((a, b) => LEAGUE_ORDER.indexOf(a) - LEAGUE_ORDER.indexOf(b));
  const seasons = Array.from(new Set(rows.map((r) => r.season))).sort();
  const vals = shown.map((r) => r[metric]).filter(isNum);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const cell = (l: string, s: string) => shown.find((r) => r.league === l && r.season === s);

  return (
    <div className="screen">
      <ScreenHead
        kicker="01 · Efficiency map"
        title="Where are bookmaker odds wrong?"
        lede="Each cell is one league-season, scored on the margin-free reference probabilities. Pick a metric; click a cell for detail and to replay its matches."
        right={
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Seg label="Snapshot" value={snapshot} onChange={setSnapshot}
              options={[{ value: "PRE_CLOSING", label: "Pre-closing" }, { value: "CLOSING", label: "Closing" }]} />
            <Seg label="Bookmaker" value={book} onChange={setBook}
              options={(books.length ? books : ["B365"]).map((b) => ({ value: b, label: b }))} />
          </div>
        }
      />
      {eff.error && <ErrorBox error={eff.error} />}
      {!eff.data && !eff.error && <Loading what="efficiency map" />}
      {eff.data && (
        <div className="row">
          <Panel title="League × season" style={{ flex: "3 1 640px" }}
            right={<Seg label="Metric" value={metric} onChange={setMetric} options={METRICS.map((x) => ({ value: x.id, label: x.label }))} />}>
            {rows.length === 0 ? (
              <div className="empty">No efficiency map yet. Part 1 produces efficiency_map.parquet.</div>
            ) : (
              <>
                <div className="scroll-x">
                  <div className="heat" style={{ gridTemplateColumns: `140px repeat(${seasons.length}, minmax(86px, 1fr))`, minWidth: 140 + seasons.length * 90 }}>
                    <div />
                    {seasons.map((s) => <div key={s} className="hdr">{s}</div>)}
                    {leagues.map((l) => (
                      <Row key={l} league={l} seasons={seasons} get={cell} m={m} metric={metric} lo={lo} hi={hi}
                        sel={sel} onSel={setSel} />
                    ))}
                  </div>
                </div>
                <Legend m={m} lo={lo} hi={hi} conventions={eff.data.sign_conventions} metric={metric} />
              </>
            )}
          </Panel>
          <div className="grid" style={{ flex: "1 1 300px", alignContent: "start" }}>
            <Panel title="Cell detail">
              {!sel ? <div className="empty">Click a cell.</div> : (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ font: "800 italic 26px/1 var(--font-d)", textTransform: "uppercase" }}>{sel.league} · {sel.season}</div>
                  <div className="dim" style={{ fontSize: 13 }}>{LEAGUE_LABEL[sel.league] ?? sel.league} · {sel.snapshot} · {sel.bookmaker}</div>
                  <dl className="kv">
                    <dt>Matches</dt><dd className="mono">{int(sel.n_matches)}</dd>
                    <dt>Log loss</dt><dd className="mono">{fix(sel.log_loss, 4)}</dd>
                    <dt>Brier (sum over 3 outcomes)</dt><dd className="mono">{fix(sel.brier, 4)}</dd>
                    <dt>Overround</dt><dd className="mono">{pct(sel.mean_overround, 2)}</dd>
                    <dt>Calibration slope</dt><dd className="mono">{fix(sel.calib_slope, 3)}</dd>
                    <dt>Fav-longshot gap</dt><dd className="mono">{spp(sel.fav_longshot_gap)}</dd>
                    <dt>Draw bias</dt><dd className="mono">{spp(sel.draw_bias)}</dd>
                  </dl>
                  <button type="button" className="btn solid" onClick={() => go("replay", { league: sel.league, season: sel.season })}>
                    Replay {sel.league} {sel.season} matches →
                  </button>
                </div>
              )}
            </Panel>
            <Panel title="Coverage">
              <dl className="kv">
                <dt>Data mode</dt><dd><span className={`chip ${eff.data.dataset_mode === "REAL" ? "cyan" : "amber"}`}>{eff.data.dataset_mode}</span></dd>
                <dt>Leagues</dt><dd className="mono">{meta.leagues.join(", ") || "n/a"}</dd>
                <dt>Seasons</dt><dd className="mono">{meta.seasons.length ? `${meta.seasons[0]} → ${meta.seasons[meta.seasons.length - 1]}` : "n/a"}</dd>
                <dt>Cells shown</dt><dd className="mono">{shown.length}</dd>
                <dt>Holdout</dt><dd>{meta.holdout_locked ? "locked result available" : "hidden until the freeze"}</dd>
              </dl>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function Row(props: {
  league: string; seasons: string[]; get: (l: string, s: string) => EfficiencyRow | undefined; m: (typeof METRICS)[number];
  metric: Metric; lo: number; hi: number; sel: EfficiencyRow | null; onSel: (r: EfficiencyRow) => void;
}) {
  return (
    <>
      <div className="rowhdr">{props.league}<div className="dim" style={{ font: "500 11px var(--font-b)", letterSpacing: 0 }}>{LEAGUE_LABEL[props.league]?.split(" · ")[1] ?? ""}</div></div>
      {props.seasons.map((s) => {
        const r = props.get(props.league, s);
        if (!r) return <div key={s} className="cell na" aria-label={`${props.league} ${s}: no data`}><span className="v">—</span></div>;
        const v = r[props.metric];
        const bg = colourFor(props.m, v, props.lo, props.hi);
        const selected = props.sel === r;
        return (
          <button key={s} type="button" className={`cell ${isNum(v) ? "" : "na"}`} style={{ background: bg }}
            aria-pressed={selected} onClick={() => props.onSel(r)}
            aria-label={`${props.league} ${s}: ${props.m.label} ${props.m.fmt(v)}, ${r.n_matches} matches`}>
            <div className="v">{props.m.fmt(v)}</div>
            <div className="n">n {int(r.n_matches)}</div>
          </button>
        );
      })}
    </>
  );
}

function Legend({ m, lo, hi, conventions, metric }: {
  m: (typeof METRICS)[number]; lo: number; hi: number; conventions: Record<string, string>; metric: Metric;
}) {
  const grad = m.kind === "seq"
    ? `linear-gradient(90deg, ${mix(NEUTRAL, CYAN, 0.15)}, ${mix(NEUTRAL, CYAN, 1)})`
    : `linear-gradient(90deg, ${mix(NEUTRAL, BLUE, 1)}, rgb(${NEUTRAL.join(",")}), ${mix(NEUTRAL, ORANGE, 1)})`;
  return (
    <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 320px) auto", gap: 10, alignItems: "center" }}>
        <span className="mono dim" style={{ fontSize: 12 }}>{m.kind === "div" ? m.fmt(Math.min(lo, m.center ?? 0)) : m.fmt(lo)}</span>
        <div className="scale" style={{ background: grad }} />
        <span className="mono dim" style={{ fontSize: 12 }}>{m.fmt(hi)}</span>
      </div>
      <div className="note">
        <b>{m.label}.</b> {m.help}
        {conventions[metric] && <> Sign convention: {conventions[metric]}.</>}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        {Object.entries(conventions).map(([k, v]) => <div key={k}><span className="mono">{k}</span>: {v}</div>)}
      </div>
    </div>
  );
}
