import type { Replay } from "../../../../contract/api_types";
import { OUTCOME_LABEL } from "../config";
import { odds, pct, spct } from "../format";
import type { Mode } from "../types";
import { bestRow } from "./Gauntlet";

type Row = Replay["per_outcome"][number];

function Bar({ v, kind }: { v: number | null | undefined; kind: "model" | "market" | "stressed" }) {
  const w = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) * 100 : 0;
  return <div className={`bar ${kind}`}><i style={{ width: `${w}%` }} /></div>;
}

/** Per-outcome table, H, D, A order: model vs market probability, offered vs adjusted odds, raw vs stressed EV. */
export function Outcomes({ rows, decision, teams, mode = "advanced" }: {
  rows: Row[]; decision: Replay["decision"]; teams?: { home: string; away: string }; mode?: Mode;
}) {
  if (!rows.length) return <div className="empty">No per-outcome pricing: the decision function had no prediction or no valid quote to price.</div>;
  const best = bestRow(decision, rows);
  const name = (o: Row["outcome"]) =>
    o === "H" && teams ? `Home · ${teams.home}` : o === "A" && teams ? `Away · ${teams.away}` : OUTCOME_LABEL[o];
  return (
    <div>
      <div className="legend" style={{ marginBottom: 8 }}>
        <span><i style={{ background: "var(--cyan)" }} />Model p</span>
        <span><i style={{ background: "var(--market)" }} />Market q (margin-free)</span>
        {mode === "advanced" && (
          <span><i style={{ background: "repeating-linear-gradient(90deg, var(--cyan) 0 3px, rgba(63,208,224,.4) 3px 5px)" }} />Stressed p′</span>
        )}
      </div>
      <div className="scroll-x">
        <table className="data" style={{ minWidth: mode === "normal" ? 560 : 760 }}>
          <thead>
            <tr>
              <th>Outcome</th>
              <th style={{ width: "26%" }}>Probability</th>
              <th className="n">Model p</th>
              <th className="n">Market q</th>
              {mode === "advanced" && <th className="n">Stressed p′</th>}
              <th className="n">Offered</th>
              <th>Bookmaker</th>
              <th className="n">Adjusted</th>
              {mode === "advanced" && <th className="n">EV raw</th>}
              {mode === "advanced" && <th className="n">EV stressed</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.outcome} className={best?.outcome === r.outcome ? "hl" : ""}>
                <td style={{ fontWeight: 600 }}>
                  {name(r.outcome)}
                  {best?.outcome === r.outcome && (
                    <span className={`chip ${decision.selection ? "green" : ""}`} style={{ marginLeft: 8 }}>
                      {decision.selection ? "pick" : "best EV"}
                    </span>
                  )}
                </td>
                <td>
                  <div style={{ display: "grid", gap: 3 }}>
                    <Bar v={r.p_model} kind="model" />
                    <Bar v={r.q_market} kind="market" />
                    {mode === "advanced" && <Bar v={r.p_stressed} kind="stressed" />}
                  </div>
                </td>
                <td className="n" style={{ color: "var(--lime)", fontWeight: 600 }}>{pct(r.p_model)}</td>
                <td className="n">{pct(r.q_market)}</td>
                {mode === "advanced" && <td className="n">{pct(r.p_stressed)}</td>}
                <td className="n">{odds(r.odds_offered)}</td>
                <td className="mono">{r.bookmaker ?? "n/a"}</td>
                <td className="n">{odds(r.odds_adjusted)}</td>
                {mode === "advanced" && <td className="n" style={{ color: r.ev_raw >= 0 ? "var(--green)" : "var(--red)" }}>{spct(r.ev_raw)}</td>}
                {mode === "advanced" && <td className="n" style={{ color: r.ev_stressed >= 0 ? "var(--green)" : "var(--red)" }}>{spct(r.ev_stressed)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mode === "advanced" && (
        <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
          EV = p × O′ − 1 per unit at the adjusted odds O′ = 1 + (O − 1)(1 − haircut). Removing the bookmaker margin
          builds the benchmark q; it never improves the payout.
        </p>
      )}
    </div>
  );
}
