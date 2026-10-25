import { useEffect, useMemo, useState } from "react";
import type { Fixture, Meta, QuoteView, Scenarios } from "../../../../contract/api_types";
import { api, useApi } from "../api";
import { Outcomes } from "../components/Outcomes";
import { Empty, ErrorBox, Field, Loading, Notes, Panel, ScreenHead, Seg } from "../components/ui";
import { HOLDOUT_SEASON, LEAGUE_LABEL, MODEL_LABEL, OUTCOME_LABEL, USE_MOCKS } from "../config";
import { day, fix, odds, pct, sfix, spct, sunits, when } from "../format";
import { setParams } from "../route";
import type { Mode, Overrides, ReplayPolicy, ReplayX, RevealX } from "../types";

function cleanDecisionText(text: string, viewMode: Mode): string {
  let out = text
    .replace(/\bpaper\s+/gi, "")
    .replace(/\bPaper\s+/g, "")
    .replace(/\bB365\b/g, "Bet365");
  if (viewMode === "normal") {
    // Strip the technical stake tail in Simple mode; it's an analysis tool, not a bet sizer.
    out = out.replace(/\s*Stake\s+[\d.]+\s*units\.?/i, "");
  }
  return out;
}

export function ReplayScreen({ meta, params, mode: viewMode = "advanced" }: { meta: Meta; params: URLSearchParams; mode?: Mode }) {
  const mode = params.get("mode") === "scenarios" ? "scenarios" : "match";
  const seasons = meta.seasons.filter((s) => meta.holdout_locked || s !== HOLDOUT_SEASON);
  const league = params.get("league") ?? (meta.leagues.includes("E0") ? "E0" : meta.leagues[0]) ?? "";
  const season = params.get("season") ?? (seasons.includes("2024-25") ? "2024-25" : seasons[seasons.length - 1]) ?? "";
  const matchId = params.get("match") ?? "";
  const model = params.get("model") ?? "";
  const policy: ReplayPolicy = params.get("policy") === "controlled_best_price" && !USE_MOCKS ? "controlled_best_price" : "controlled";
  const update = (p: Record<string, string | undefined>) =>
    setParams("replay", { mode, league, season, match: matchId, model, policy, ...p });

  return (
    <div className="screen">
      <ScreenHead
        kicker="Match replay"
        title={mode === "match" ? (viewMode === "normal" ? "Would we have bet?" : "Replay the decision") : "Demonstration scenarios"}
        lede={mode === "match"
          ? (viewMode === "normal"
            ? "Pick a match and see our forecast — did the bookmaker get the odds wrong?"
            : "Replay one fixture at the pre-closing quote: our probability against the market, the price we would get, and every policy gate.")
          : "Three constructed scenarios that show how the policy gates behave."}
        right={viewMode === "advanced" ? (
          <Seg label="Replay mode" value={mode} onChange={(m) => update({ mode: m })}
            options={[{ value: "match", label: "Historical match" }, { value: "scenarios", label: "Demo scenarios" }]} />
        ) : undefined}
        tone={mode === "scenarios" ? "amber" : undefined}
      />
      {mode === "match" ? (
        <div className="replay-layout">
          <MatchPicker meta={meta} seasons={seasons} league={league} season={season} matchId={matchId}
            model={model} onChange={update} />
          {matchId ? <MatchReplay key={matchId + (model ?? "")} matchId={matchId} model={model || undefined} policy={policy}
            onPolicyChange={(p) => update({ policy: p })} meta={meta} viewMode={viewMode} />
            : <Empty>Pick a fixture on the left.</Empty>}
        </div>
      ) : (
        <ScenarioView id={params.get("scenario") ?? ""} onPick={(id) => setParams("replay", { mode, league, season, match: matchId, model, scenario: id })} />
      )}
    </div>
  );
}

function MatchPicker(props: {
  meta: Meta; seasons: string[]; league: string; season: string; matchId: string; model: string;
  onChange: (p: Record<string, string | undefined>) => void;
}) {
  const { meta, league, season, matchId } = props;
  const fx = useApi<Fixture[]>(() => api.fixtures(league, season), [league, season]);
  const list = fx.data ?? [];

  // Default to the first fixture once the list arrives.
  useEffect(() => {
    if (!matchId && list.length) props.onChange({ match: list[0].match_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, matchId]);

  const labelFor = (f: Fixture) => `${f.home_team} v ${f.away_team} · ${day(f.kickoff_utc)}`;

  return (
    <Panel title="Fixture">
      <div style={{ display: "grid", gap: 10 }}>
        <Field label="League" htmlFor="rp-league">
          <select id="rp-league" value={league} onChange={(e) => props.onChange({ league: e.target.value, match: undefined })}>
            {meta.leagues.map((l) => <option key={l} value={l}>{LEAGUE_LABEL[l] ?? l}</option>)}
          </select>
        </Field>
        <Field label="Season" htmlFor="rp-season">
          <select id="rp-season" value={season} onChange={(e) => props.onChange({ season: e.target.value, match: undefined })}>
            {props.seasons.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Match" htmlFor="rp-match">
          <select id="rp-match" value={matchId} onChange={(e) => props.onChange({ match: e.target.value })}>
            {!list.length && <option value="">—</option>}
            {list.map((f) => <option key={f.match_id} value={f.match_id}>{labelFor(f)}</option>)}
          </select>
        </Field>
        {fx.error && <ErrorBox error={fx.error} />}
        {fx.loading && !fx.data && <Loading what="fixtures" />}
        {fx.data && list.length === 0 && <Empty>No fixtures.</Empty>}
      </div>
    </Panel>
  );
}

function MatchReplay({ matchId, model, policy, onPolicyChange, meta, viewMode = "advanced" }: { matchId: string; model?: string; policy: ReplayPolicy; onPolicyChange: (p: ReplayPolicy) => void; meta: Meta; viewMode?: Mode }) {
  const locked = useApi<ReplayX>(() => api.replay(matchId, model, undefined, policy), [matchId, model, policy]);
  const [sl, setSl] = useState<Required<Overrides> | null>(null);
  const [overrides, setOverrides] = useState<Overrides | null>(null);
  const explore = useApi<ReplayX | null>(
    () => (overrides ? api.replay(matchId, model, overrides, policy) : Promise.resolve(null)),
    [matchId, model, policy, JSON.stringify(overrides)],
  );
  const [reveal, setReveal] = useState<{ data?: RevealX; error?: string; loading?: boolean }>({});
  // Clear the revealed result when the user switches policy — closing odds / P&L are
  // policy-specific, so the previous reveal would be stale under the new price source.
  useEffect(() => { setReveal({}); }, [policy]);

  // initialise the sliders from the locked policy
  useEffect(() => {
    if (locked.data && !sl) {
      const c = locked.data.config_used;
      setSl({ prob_stress_delta: c.prob_stress_delta, price_haircut: c.price_haircut, min_ev: c.min_ev });
    }
  }, [locked.data, sl]);

  // debounce slider changes into an exploratory request
  useEffect(() => {
    if (!sl || !locked.data) return;
    const c = locked.data.config_used;
    const same = sl.prob_stress_delta === c.prob_stress_delta && sl.price_haircut === c.price_haircut && sl.min_ev === c.min_ev;
    const t = window.setTimeout(() => setOverrides(same ? null : { ...sl }), 220);
    return () => window.clearTimeout(t);
  }, [sl, locked.data]);

  if (locked.error) return <ErrorBox error={locked.error} />;
  if (!locked.data) return <Loading what="replay" />;
  const baseline = locked.data.config_used;
  const changed = !!sl && (sl.prob_stress_delta !== baseline.prob_stress_delta || sl.price_haircut !== baseline.price_haircut || sl.min_ev !== baseline.min_ev);
  const waitingForValues = !!sl && (!overrides || overrides.prob_stress_delta !== sl.prob_stress_delta || overrides.price_haircut !== sl.price_haircut || overrides.min_ev !== sl.min_ev);
  const pending = changed && !explore.error && (waitingForValues || explore.loading || !explore.data);
  const r: ReplayX = changed && !pending && explore.data ? explore.data : locked.data;
  const isExp = changed || r.is_exploratory;
  const m = r.match;
  const bet = r.decision.action === "BET";

  const doReveal = () => {
    setReveal({ loading: true });
    api.reveal(matchId, model, policy).then((data) => setReveal({ data }), (e: Error) => setReveal({ error: e.message }));
  };

  return (
    <div className="grid grid-tight" style={{ alignContent: "start" }}>
      {isExp && (
        <div className="exploratory" role="status">
          <b>EXPLORATORY</b>
          <span>{pending ? "Updating your scenario. The recorded policy remains below until the API responds." : explore.error ? "The scenario request failed. The recorded policy is shown below; your changes were not saved." : "Recomputed with your slider values. This is a what-if, not the locked result, and nothing is saved."}</span>
          <button type="button" className="btn ghost" style={{ marginLeft: "auto", minHeight: 32 }}
            onClick={() => { const c = locked.data!.config_used; setSl({ prob_stress_delta: c.prob_stress_delta, price_haircut: c.price_haircut, min_ev: c.min_ev }); }}>
            Back to locked
          </button>
        </div>
      )}

      {/* Row 1: Decision | Offered Quote (equal columns) */}
      <div className="replay-main" aria-busy={pending}>
        <Panel tone={bet ? "green" : "red"} className={isExp ? "is-exp" : ""}>
          <div className="match-head">
            <div className="label">{m.league} · {m.season} · <span className="chip">{m.split ?? "n/a"}</span></div>
            <div className="match-teams">{m.home_team} <span className="dim" style={{ fontWeight: 600 }}>v</span> {m.away_team}</div>
            <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>
              Kickoff {when(m.kickoff_utc)}
              {viewMode === "advanced" && r.model && <> · {r.model.model_id} <span className="mono">{r.model.model_version}</span></>}
            </div>
          </div>
          <div className="verdict">
            <div>
              <div className="label">Model call{viewMode === "advanced" && r.x_decision_source === "ledger" ? " · from ledger" : viewMode === "advanced" && r.x_decision_source === "live" ? " · computed live" : ""}</div>
              <h2 className={`verdict-word ${bet ? "bet" : "nobet"}`}>
                {bet ? `Back ${OUTCOME_LABEL[r.decision.selection!]}` : "No value"}
              </h2>
            </div>
          </div>
          <p className="explanation">{cleanDecisionText(r.decision.explanation, viewMode)}</p>
          {viewMode === "advanced" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {r.decision.reason_codes_all.map((c) => (
                <span key={c} className={`chip ${c === "ACCEPTED" ? "green" : c === r.decision.reason_code ? "red" : "amber"}`}>{c}</span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
            <button type="button" className="btn solid" onClick={doReveal} disabled={reveal.loading || !!reveal.data || pending}>
              {reveal.data ? "Revealed below" : "Reveal the result"}
            </button>
          </div>
          {viewMode === "advanced" && <div style={{ marginTop: 10 }}><Notes notes={r.x_notes} /></div>}
        </Panel>

        <QuoteCard quote={r.offered_quote} cutoff={r.information_cutoff_utc} valid={r.x_quote_is_valid}
          policy={policy} onPolicyChange={onPolicyChange} viewMode={viewMode} />
      </div>

      {/* Row 2 (Expert only): Stress sliders | What drove the model */}
      {viewMode === "advanced" && (
        <div className="replay-main">
          <Panel title="Stress the edge" sub="Exploratory what-ifs through the shared decision function" tone="amber">
            {USE_MOCKS ? (
              <div className="note amber">Sliders need the backend: mock mode cannot rerun the decision function.</div>
            ) : sl ? (
              <div style={{ display: "grid", gap: 12 }}>
                <Slider id="sl-d" label="Probability stress δ" hint="sensitivity assumption (not a confidence interval)"
                  value={sl.prob_stress_delta} min={0} max={0.1} step={0.005} fmt={(v) => `${(v * 100).toFixed(1)} pp`}
                  onChange={(v) => setSl({ ...sl, prob_stress_delta: v })} />
                <Slider id="sl-h" label="Price haircut" hint="O′ = 1 + (O − 1)(1 − h): a worse fill than quoted"
                  value={sl.price_haircut} min={0} max={0.1} step={0.005} fmt={(v) => `${(v * 100).toFixed(1)}%`}
                  onChange={(v) => setSl({ ...sl, price_haircut: v })} />
                <Slider id="sl-m" label="Minimum EV" hint="per unit staked, at the adjusted odds"
                  value={sl.min_ev} min={0} max={0.1} step={0.005} fmt={(v) => spct(v)}
                  onChange={(v) => setSl({ ...sl, min_ev: v })} />
                {explore.loading && overrides && <Loading what="exploratory decision" />}
                {explore.error && <ErrorBox error={explore.error} />}
              </div>
            ) : <Loading what="policy" />}
          </Panel>
          <Panel title="What drove the model" sub={r.model ? `${MODEL_LABEL[r.model.model_id] ?? r.model.model_id} · per-match contributions` : undefined}>
            <TopFeatures rows={r.top_features} />
          </Panel>
        </div>
      )}

      {/* Row 3: Outcomes full width */}
      <Panel title="Model vs market, per outcome" sub="Outcome order H · D · A">
        <Outcomes rows={r.per_outcome} decision={r.decision} teams={{ home: m.home_team, away: m.away_team }} mode={viewMode} />
      </Panel>

      {/* Row 4: Reveal (full width, conditional) */}
      {(reveal.data || reveal.error || reveal.loading) && (
        <Panel title="Revealed after the decision" sub="Closing odds and the result were never inputs to the decision" tone="amber">
          {reveal.loading && <Loading what="closing odds and result" />}
          {reveal.error && <ErrorBox error={reveal.error} />}
          {isExp && <p className="note">CLV and P&amp;L below belong to the recorded policy, not the exploratory slider decision.</p>}
          {reveal.data && <RevealView rv={reveal.data} bet={locked.data.decision.action === "BET"} selection={locked.data.decision.selection} home={m.home_team} away={m.away_team} viewMode={viewMode} />}
        </Panel>
      )}
    </div>
  );
}

function Slider(props: { id: string; label: string; hint: string; value: number; min: number; max: number; step: number;
  fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <label htmlFor={props.id} style={{ fontWeight: 600, fontSize: 14 }}>{props.label}</label>
        <span className="mono" style={{ color: "var(--amber)" }}>{props.fmt(props.value)}</span>
      </div>
      <input id={props.id} type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))} style={{ accentColor: "var(--amber)" }} />
      <div className="dim" style={{ fontSize: 12 }}>{props.hint}</div>
    </div>
  );
}

const prettyBookmaker = (code?: string | null) => {
  if (!code) return "n/a";
  const map: Record<string, string> = { B365: "Bet365", PS: "Pinnacle", BW: "Betway", IW: "Interwetten",
    WH: "William Hill", VC: "VC Bet", MAX: "Max", AVG: "Average", BEST: "Best valid" };
  return map[code] ?? code;
};

function QuoteCard({ quote, cutoff, valid, policy, onPolicyChange, viewMode = "advanced" }: {
  quote: QuoteView | null; cutoff: string; valid?: boolean | null;
  policy: ReplayPolicy; onPolicyChange: (p: ReplayPolicy) => void; viewMode?: Mode;
}) {
  const isBest = policy === "controlled_best_price";
  return (
    <Panel title="Offered quote" sub={viewMode === "normal"
      ? (isBest ? "Best valid price across bookmakers" : "Reference pre-closing quote")
      : (quote?.bookmaker === "BEST" ? "Best valid price per outcome; Bet365 remains the probability benchmark" : "Bet365 reference pre-closing quote")
    }>
      {!quote ? <Empty>No reference pre-closing quote.</Empty> : (
        <div style={{ display: "grid", gap: 14 }}>
          <div className="price-toggle" role="group" aria-label="Price source">
            <span className="price-toggle-indicator" data-at={isBest ? "best" : "ref"} aria-hidden="true" />
            <button type="button" aria-pressed={!isBest} onClick={() => onPolicyChange("controlled")}>
              Bet365
            </button>
            <button type="button" aria-pressed={isBest}
              disabled={USE_MOCKS}
              title={USE_MOCKS ? "Mock mode uses the Bet365 example only" : undefined}
              onClick={() => onPolicyChange("controlled_best_price")}>
              Best valid price
            </button>
          </div>
          <div className="odds3">
            {(["H", "D", "A"] as const).map((o, i) => (
              <div key={o}>
                <div className="label">{OUTCOME_LABEL[o]}</div>
                <div className="o">{odds(quote.odds[i])}</div>
                <span className="quote-bookmaker">{prettyBookmaker(quote.bookmakers?.[i] ?? quote.bookmaker)}</span>
              </div>
            ))}
          </div>
          {viewMode === "normal" && isBest && quote.source && (
            <p className="dim" style={{ fontSize: 12, margin: 0 }}>Source: {quote.source}</p>
          )}
          {viewMode === "advanced" && (
            <dl className="kv" style={{ fontSize: 13 }}>
              <dt>Bookmaker</dt><dd>{prettyBookmaker(quote.bookmaker)}{valid === false && <span className="chip red" style={{ marginLeft: 8 }}>failed validation</span>}</dd>
              <dt>Snapshot</dt><dd className="mono">{quote.snapshot}</dd>
              <dt>Observed</dt><dd className="mono">{when(quote.observed_at_utc)}</dd>
              <dt>Precision</dt><dd><span className={`chip ${quote.timestamp_precision === "UNKNOWN" ? "red" : quote.timestamp_precision === "EXACT" ? "green" : "amber"}`}>{quote.timestamp_precision}</span></dd>
              <dt>Source</dt><dd className="mono">{quote.source}</dd>
              <dt>Quote id</dt><dd className="mono">{quote.quote_id}</dd>
              <dt>Model cutoff</dt><dd className="mono">{when(cutoff)}</dd>
            </dl>
          )}
        </div>
      )}
    </Panel>
  );
}

function TopFeatures({ rows }: { rows: ReplayX["top_features"] }) {
  if (!rows.length)
    return <Empty>No per-match explanation for this model. Part 2 provides them for LightGBM (SHAP) and MarketNet.</Empty>;
  const max = Math.max(...rows.map((r) => Math.abs(r.contribution)), 1e-9);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {(["H", "D", "A"] as const).map((o) => {
        const rs = rows.filter((r) => r.outcome === o);
        if (!rs.length) return null;
        return (
          <div key={o}>
            <div className="label" style={{ marginBottom: 4 }}>{OUTCOME_LABEL[o]}</div>
            {rs.map((f) => {
              const w = (Math.abs(f.contribution) / max) * 50;
              return (
                <div key={f.rank} className="feat-row">
                  <span style={{ minWidth: 0 }}>
                    <span className="mono" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.feature}>{f.feature}</span>
                    <span className="mono dim" style={{ fontSize: 11 }}>value {fix(f.feature_value, 3)}</span>
                  </span>
                  <div className="feat-bar">
                    <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--line2)" }} />
                    <i style={{ left: f.contribution >= 0 ? "50%" : `${50 - w}%`, width: `${w}%`, background: f.contribution >= 0 ? "var(--cyan)" : "var(--orange)" }} />
                  </div>
                  <span className="mono" style={{ textAlign: "right" }}>{sfix(f.contribution, 3)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      <div className="legend"><span><i style={{ background: "var(--cyan)" }} />pushes this outcome up</span><span><i style={{ background: "var(--orange)" }} />pushes it down</span></div>
    </div>
  );
}

function RevealView({ rv, bet, selection, home, away, viewMode = "advanced" }: {
  rv: RevealX; bet: boolean; selection: string | null; home?: string; away?: string; viewMode?: Mode;
}) {
  const won = bet && selection === rv.result.result;
  const verdictClass = bet ? (won ? "won" : "lost") : "nobet";
  return (
    <div className="reveal-grid">
      <div className={`result-banner result-${verdictClass}`}>
        <div className="result-score">
          {home && <span className="result-team">{home}</span>}
          <span className="result-goals">{rv.result.home_goals}</span>
          <span className="result-sep">–</span>
          <span className="result-goals">{rv.result.away_goals}</span>
          {away && <span className="result-team">{away}</span>}
        </div>
        <div className="result-outcome">{OUTCOME_LABEL[rv.result.result]}</div>
        {bet && (
          <div className={`result-verdict ${verdictClass}`}>
            <span className="result-verdict-icon" aria-hidden="true">{won ? "✓" : "✗"}</span>
            <span>{won ? "BET WON" : "BET LOST"}</span>
          </div>
        )}
      </div>
      <div className="reveal-side grid cols-2">
        <div>
          <div className="label">Closing odds {rv.closing_quote ? `· ${prettyBookmaker(rv.closing_quote.bookmaker)}` : ""}</div>
          {rv.closing_quote ? (
            <>
              <div className="mono" style={{ fontSize: 18 }}>{rv.closing_quote.odds.map((o) => odds(o)).join(" · ")}</div>
              {viewMode === "advanced" && (
                <div className="dim mono" style={{ fontSize: 12 }}>fair {rv.closing_fair_probs ? rv.closing_fair_probs.map((p) => pct(p)).join(" · ") : "n/a"}</div>
              )}
            </>
          ) : <div className="dim">n/a</div>}
        </div>
        <div>
          <div className="label">{viewMode === "normal" ? "Payout" : "Closing line value · P&L"}</div>
          <div className="mono" style={{ fontSize: 18 }}>
            {viewMode === "normal" ? sunits(rv.settled_pnl) : `CLV ${spct(rv.clv)} · ${sunits(rv.settled_pnl)}`}
          </div>
        </div>
      </div>
      {rv.x_notes && rv.x_notes.length > 0 && viewMode === "advanced" && <Notes notes={rv.x_notes} />}
    </div>
  );
}

function ScenarioView({ id, onPick }: { id: string; onPick: (id: string) => void }) {
  const sc = useApi<Scenarios>(() => api.scenarios(), []);
  if (sc.error) return <ErrorBox error={sc.error} />;
  if (!sc.data) return <Loading what="scenarios" />;
  const list = sc.data.scenarios;
  const s = list.find((x) => x.id === id) ?? list[0];
  if (!s) return <Empty>No scenarios.</Empty>;
  const bet = s.decision.action === "BET";
  return (
    <div className="grid">
      <div className="exploratory" style={{ marginBottom: 0 }}><b>CONSTRUCTED</b><span>{sc.data.label}</span></div>
      <div className="grid cols-3">
        {list.map((x, i) => (
          <button key={x.id} type="button" className="scenario" aria-pressed={x.id === s.id} onClick={() => onPick(x.id)}>
            <div className="label">Scenario {i + 1}</div>
            <div style={{ font: "800 italic 22px/1.1 var(--font-d)", textTransform: "uppercase", margin: "4px 0" }}>{x.title}</div>
            <div className="mono dim" style={{ fontSize: 12 }}>p {x.p_model.map((p) => pct(p)).join(" · ")}</div>
            <div className="mono dim" style={{ fontSize: 12 }}>odds {x.odds.map((o) => odds(o)).join(" · ")} · {x.timestamp_precision}</div>
            <div style={{ marginTop: 8 }}><span className={`chip ${x.decision.action === "BET" ? "green" : "red"}`}>{x.decision.action === "BET" ? "BET" : "NO BET"} · {x.decision.reason_code}</span></div>
          </button>
        ))}
      </div>
      <Panel tone={bet ? "green" : "red"}>
        <div className="verdict">
          <div>
            <div className="label">Model call · constructed inputs</div>
            <h2 className={`verdict-word ${bet ? "bet" : "nobet"}`}>{bet ? `Back ${OUTCOME_LABEL[s.decision.selection!]}` : "No value"}</h2>
          </div>
        </div>
        <p className="explanation">{cleanDecisionText(s.decision.explanation, "advanced")}</p>
      </Panel>
      <Panel title="Per outcome">
        <Outcomes rows={s.per_outcome} decision={s.decision} />
      </Panel>
    </div>
  );
}
