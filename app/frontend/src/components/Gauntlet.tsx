import { useEffect, useState } from "react";
import type { PolicyConfig, QuoteView, Replay } from "../../../../contract/api_types";
import { spct, units } from "../format";

export type CheckStatus = "pass" | "blocked" | "failed" | "skipped" | "off";
export interface Check { id: string; label: string; value: string; status: CheckStatus }

type Decision = Replay["decision"];
type PerOutcome = Replay["per_outcome"];

const CODES: Record<string, string[]> = {
  pred: ["MISSING_PREDICTION"],
  quote: ["MISSING_QUOTE"],
  price: ["INVALID_PRICE"],
  fresh: ["STALE_QUOTE"],
  league: ["LEAGUE_NOT_ELIGIBLE"],
  ev: ["EV_BELOW_THRESHOLD"],
  stress: ["FAILS_STRESS"],
  size: ["EXPOSURE_LIMIT_MATCH", "EXPOSURE_LIMIT_TOTAL", "INSUFFICIENT_BANKROLL"],
};

/** The outcome the decision function priced: the selection if it bet, else the highest raw EV row. */
export function bestRow(decision: Decision, perOutcome: PerOutcome) {
  if (!perOutcome.length) return null;
  if (decision.selection) return perOutcome.find((r) => r.outcome === decision.selection) ?? null;
  return perOutcome.reduce((a, b) => (b.ev_raw > a.ev_raw ? b : a));
}

/**
 * Map the decision record's reason codes onto the checks of CONTRACT 6.2, in order.
 * Nothing is recomputed: a check is red only if its code is in reason_codes_all; the first
 * failure (reason_code) is where the ball is stopped.
 */
export function buildChecks(args: {
  decision: Decision; perOutcome: PerOutcome; config?: PolicyConfig | null;
  quote?: QuoteView | null; precision?: string | null; modelLabel?: string | null;
}): Check[] {
  const { decision, perOutcome, config, quote } = args;
  const fails = new Set<string>(decision.reason_codes_all.filter((c) => c !== "ACCEPTED"));
  const priced = perOutcome.length > 0;
  const earlyFail = [...fails].some((c) => !CODES.size.includes(c));
  const best = bestRow(decision, perOutcome);
  const evaluated: Record<string, boolean> = {
    pred: true,
    quote: true,
    price: !fails.has("MISSING_QUOTE"),
    fresh: !fails.has("MISSING_QUOTE") && !fails.has("INVALID_PRICE"),
    league: config?.league_gate === true,
    ev: priced,
    stress: priced && !fails.has("EV_BELOW_THRESHOLD"),
    size: !earlyFail,
  };
  const status = (id: string): CheckStatus => {
    if (id === "league" && config && !config.league_gate) return "off";
    const hit = CODES[id].filter((c) => fails.has(c));
    if (hit.length) return hit.includes(decision.reason_code) ? "blocked" : "failed";
    return evaluated[id] ? "pass" : "skipped";
  };
  const oddsOk = quote?.odds?.every((o) => typeof o === "number" && Number.isFinite(o));
  const minEv = config ? spct(config.min_ev) : "the minimum";
  const delta = config ? `${(config.prob_stress_delta * 100).toFixed(1)}pp` : "δ";
  const defs: [string, string, string][] = [
    ["pred", "Prediction", fails.has("MISSING_PREDICTION") ? "none" : args.modelLabel ?? "present"],
    ["quote", "Reference quote", quote ? `${quote.bookmaker} pre-closing` : fails.has("MISSING_QUOTE") ? "none" : "present"],
    ["price", "Valid price", fails.has("INVALID_PRICE") ? "invalid" : oddsOk ? "all odds > 1.00" : "—"],
    ["fresh", "Fresh quote", args.precision ?? quote?.timestamp_precision ?? "—"],
    ["league", "League gate", config?.league_gate ? (fails.has("LEAGUE_NOT_ELIGIBLE") ? "not eligible" : "eligible") : "gate off"],
    ["ev", "EV ≥ minimum", best ? `${spct(best.ev_raw)} vs ${minEv}` : "not priced"],
    ["stress", "Survives stress", best && priced && !fails.has("EV_BELOW_THRESHOLD") ? `${spct(best.ev_stressed)} at −${delta}` : "—"],
    ["size", "Stake & caps", decision.action === "BET" ? units(decision.stake) : [...fails].find((c) => CODES.size.includes(c))?.replace(/_/g, " ").toLowerCase() ?? "—"],
  ];
  return defs.map(([id, label, value]) => ({ id, label, value, status: status(id) }));
}

const POS = [8, 18.5, 29, 39.5, 50, 60.5, 71, 81.5];

/** The checks as defenders on a strip of pitch. The ball runs until the first failing check. */
export function Gauntlet({ checks, bet, animKey }: { checks: Check[]; bet: boolean; animKey: string }) {
  const [go, setGo] = useState(false);
  const [done, setDone] = useState(false);
  const [nonce, setNonce] = useState(0);
  const stopIdx = checks.findIndex((c) => c.status === "blocked");
  const target = stopIdx >= 0 ? POS[stopIdx] - 4 : bet ? 96.5 : POS[POS.length - 1] + 5;
  const dur = Math.round(350 + 1700 * ((target - 3) / 94));

  useEffect(() => {
    setGo(false);
    setDone(false);
    const t1 = window.setTimeout(() => setGo(true), 80);
    const t2 = window.setTimeout(() => setDone(true), 80 + dur + 40);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [animKey, nonce, dur]);

  const scored = done && bet && stopIdx < 0;
  return (
    <div>
      <div className="gauntlet" role="img"
        aria-label={`Decision checks: ${checks.map((c) => `${c.label} ${c.status}`).join(", ")}. ${bet ? "Paper bet placed." : "No bet."}`}>
        <div className="track" />
        <div className="trail" style={{ width: go ? `${target - 3}%` : 0, transition: go ? `width ${dur}ms linear` : "none" }} />
        <div className={`goal ${scored ? "scored" : ""}`} />
        {checks.map((c, i) => {
          const passDelay = Math.round(dur * ((POS[i] - 3) / (target - 3)));
          let cls: string = "idle";
          if (go && c.status === "pass" && POS[i] < target) cls = "pass";
          if (done) cls = c.status;
          return (
            <div key={c.id} className={`def ${cls} ${i % 2 ? "alt" : ""}`} style={{ left: `${POS[i]}%`, ["--delay" as string]: cls === "pass" && !done ? `${passDelay}ms` : "0ms" }}>
              <div className="tag">
                <div className="t">{c.label}</div>
                <div className="v">{go && (cls !== "idle" || done) ? c.value : c.status === "off" ? "gate off" : "…"}</div>
              </div>
              <svg className="body" viewBox="0 0 30 46" aria-hidden="true">
                <circle cx="15" cy="6" r="5" fill="#E8EEF6" />
                <path d="M6 15 Q15 11 24 15 L22.5 32 L7.5 32 Z" fill="#E8EEF6" />
                <path d="M9 32 L8.5 45 L13 45 L14.4 34 L15.6 34 L17 45 L21.5 45 L21 32 Z" fill="#C9D5E6" />
              </svg>
              <span className="badge-n">{cls === "pass" ? "✓" : cls === "blocked" || cls === "failed" ? "✕" : i + 1}</span>
            </div>
          );
        })}
        <span className={`ball ${go && !done ? "rolling" : ""} ${done && stopIdx >= 0 ? "bounce" : ""}`}
          style={{ left: `${go ? target : 3}%`, transition: go ? `left ${dur}ms linear` : "none" }} />
      </div>
      <div className="gauntlet-legend">
        <span><span className="chip green">✓ passed</span></span>
        <span><span className="chip red">✕ stopped here / also failed</span></span>
        <span className="dim">Faded: not reached, or switched off in this policy.</span>
        <button type="button" className="btn ghost" style={{ minHeight: 28, padding: "0 10px", fontSize: 12, marginLeft: "auto" }}
          onClick={() => setNonce((n) => n + 1)}>Replay the run</button>
      </div>
    </div>
  );
}
