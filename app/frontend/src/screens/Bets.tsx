import { useMemo, useState } from "react";
import type { Meta } from "../../../../contract/api_types";
import { api, useApi, type BetSummary } from "../api";
import { Empty, ErrorBox, Field, Loading, ScreenHead } from "../components/ui";
import { HOLDOUT_SEASON, LEAGUE_LABEL, OUTCOME_LABEL } from "../config";
import { day, odds as oddsFmt, pct } from "../format";
import { go } from "../route";
import type { Mode } from "../types";

export function BetsScreen({ meta, params, mode }: { meta: Meta; params: URLSearchParams; mode: Mode }) {
  const seasons = meta.seasons.filter((s) => meta.holdout_locked || s !== HOLDOUT_SEASON);
  // Default: all leagues (empty string). The user can filter in via the dropdown.
  const [league, setLeague] = useState(() => params.get("league") ?? "");
  const [season, setSeason] = useState(
    () => params.get("season") ?? (seasons.includes("2024-25") ? "2024-25" : seasons[seasons.length - 1]) ?? "",
  );
  const [q, setQ] = useState("");

  const bets = useApi<BetSummary[]>(() => api.bets(league || undefined, season), [league, season]);

  const edgeOf = (b: BetSummary) =>
    b.model_p !== null && b.market_q !== null ? b.model_p - b.market_q : -Infinity;

  const list = useMemo(() => {
    const all = bets.data ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter((b) => `${b.home_team} ${b.away_team}`.toLowerCase().includes(needle))
      : all;
    return [...filtered].sort((a, b) => {
      const ea = edgeOf(a);
      const eb = edgeOf(b);
      if (eb !== ea) return eb - ea;
      return a.kickoff_utc.localeCompare(b.kickoff_utc);
    });
  }, [bets.data, q]);

  const leagueName = (code: string) => {
    const label = LEAGUE_LABEL[code] ?? code;
    return label.includes("·") ? label.split("·")[1].trim() : label;
  };

  return (
    <div className="screen">
      <ScreenHead
        kicker="Best Bets"
        title="Where's the value?"
        lede={
          mode === "normal"
            ? "Fixtures ranked by how much more likely our model thinks the outcome is than the bookmaker. Highest edge at the top."
            : "Fixtures ranked by stressed EV. Click any row for the full decision breakdown."
        }
      />

      <div className="bets-toolbar">
        <Field label="League" htmlFor="bt-league">
          <select id="bt-league" value={league} onChange={(e) => setLeague(e.target.value)}>
            <option value="">All leagues</option>
            {meta.leagues.map((l) => (
              <option key={l} value={l}>{LEAGUE_LABEL[l] ?? l}</option>
            ))}
          </select>
        </Field>
        <Field label="Season" htmlFor="bt-season">
          <select id="bt-season" value={season} onChange={(e) => setSeason(e.target.value)}>
            {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Search" htmlFor="bt-q">
          <input id="bt-q" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Team name…" />
        </Field>
      </div>

      {bets.error && <ErrorBox error={bets.error} />}
      {bets.loading && !bets.data && <Loading what="best bets" />}
      {bets.data && list.length === 0 && <Empty>No fixtures match this filter.</Empty>}

      {list.length > 0 && (
        <div className="bet-list">
          {list.map((b) => (
            <BetRow key={b.match_id} bet={b} leagueName={leagueName(b.league)} mode={mode} />
          ))}
        </div>
      )}
    </div>
  );
}

function BetRow({ bet: b, leagueName, mode }: { bet: BetSummary; leagueName: string; mode: Mode }) {
  const teams: Record<"H" | "D" | "A", string> = { H: b.home_team, D: "Draw", A: b.away_team };
  const pick = teams[b.selection];
  const edgePP = b.model_p !== null && b.market_q !== null ? (b.model_p - b.market_q) * 100 : 0;
  const strong = edgePP > 0 && b.action === "BET";
  const bookmakerName = b.bookmaker === "B365" ? "Bet365" : (b.bookmaker ?? "Bet365");

  return (
    <button type="button"
      className={`bet-row ${strong ? "bet-row-strong" : ""}`}
      onClick={() => go("replay", { league: b.league, season: b.season, match: b.match_id })}>

      <div className="bet-row-match">
        <div className="bet-row-teams">
          <span>{b.home_team}</span>
          <span className="bet-row-vs">vs</span>
          <span>{b.away_team}</span>
        </div>
        <div className="bet-row-meta">{leagueName} · {day(b.kickoff_utc)}</div>
      </div>

      <div className="bet-row-pick">
        <div className="bet-row-label">{mode === "normal" ? "Back" : "Pick"}</div>
        <div className="bet-row-pick-name">{pick}</div>
        <div className="bet-row-outcome">{OUTCOME_LABEL[b.selection]}</div>
      </div>

      <div className="bet-row-probs">
        <div><span className="bet-row-plabel">Model</span><span className="mono">{pct(b.model_p)}</span></div>
        <div><span className="bet-row-plabel">Bookie</span><span className="mono">{pct(b.market_q)}</span></div>
      </div>

      <div className={`bet-row-edge ${edgePP > 0 ? "positive" : "negative"}`}>
        <div className="bet-row-edge-value">{edgePP >= 0 ? "+" : ""}{edgePP.toFixed(1)}%</div>
        <div className="bet-row-edge-label">Edge</div>
      </div>

      <div className="bet-row-odds">
        <div className="bet-row-odds-value mono">{oddsFmt(b.odds_offered)}</div>
        <div className="bet-row-odds-label">{bookmakerName}</div>
      </div>

      <div className="bet-row-arrow" aria-hidden="true">→</div>
    </button>
  );
}
