// API client. With VITE_USE_MOCKS=1 every call is answered from contract/golden/api/*.json,
// so the UI works before the backend exists (SPEC section 4).
import type {
  Audit, EfficiencyMap, Explain, Fixture, Meta, Scenarios,
} from "../../../contract/api_types";
import { USE_MOCKS } from "./config";
import type { EvidenceX, Overrides, ReplayPolicy, ReplayX, RevealX } from "./types";

export type BetSummary = {
  match_id: string; league: string; season: string; kickoff_utc: string;
  home_team: string; away_team: string; split: string | null; has_closing: boolean;
  selection: "H" | "D" | "A"; model_p: number | null; market_q: number | null;
  ev_stressed: number | null; odds_offered: number | null; bookmaker: string | null;
  action: "BET" | "NO_BET";
};

const mocks = import.meta.glob("../../../contract/golden/api/*.json", { import: "default" });

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function mock<T>(name: string): Promise<T> {
  const loader = mocks[`../../../contract/golden/api/${name}.json`];
  if (!loader) throw new ApiError(404, `No mock for ${name}`);
  await new Promise((r) => setTimeout(r, 120));
  return structuredClone(await loader()) as T;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const api = {
  meta: () => (USE_MOCKS ? mock<Meta>("meta") : call<Meta>("/api/meta")),
  efficiencyMap: () => (USE_MOCKS ? mock<EfficiencyMap>("efficiency_map") : call<EfficiencyMap>("/api/efficiency-map")),
  fixtures: (league?: string, season?: string) =>
    USE_MOCKS ? mock<Fixture[]>("fixtures") : call<Fixture[]>(`/api/fixtures${qs({ league, season })}`),
  bets: async (league?: string, season?: string): Promise<BetSummary[]> => {
    if (USE_MOCKS) {
      const [fixtures, r] = await Promise.all([mock<Fixture[]>("fixtures"), mock<ReplayX>("replay")]);
      const rows = r.per_outcome ?? [];
      if (!rows.length) return [];
      const sel = r.decision.selection as "H" | "D" | "A" | null;
      const chosen = (sel && rows.find((x) => x.outcome === sel)) ??
        rows.reduce((best, cur) => ((cur.ev_stressed ?? -1e9) > (best.ev_stressed ?? -1e9) ? cur : best), rows[0]);
      // Add deterministic variation so each fixture shows a different edge in demo mode
      const hash = (s: string) => {
        let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return h;
      };
      return fixtures.map((f) => {
        const n = (hash(f.match_id) % 2000) / 10000; // -0.1..+0.1
        return {
          match_id: f.match_id, league: f.league, season: f.season, kickoff_utc: f.kickoff_utc,
          home_team: f.home_team, away_team: f.away_team, split: f.split, has_closing: f.has_closing,
          selection: chosen.outcome,
          model_p: Math.min(0.98, Math.max(0.02, (chosen.p_model ?? 0.5) + n)),
          market_q: chosen.q_market ?? null,
          ev_stressed: (chosen.ev_stressed ?? 0) + n,
          odds_offered: chosen.odds_offered ?? null,
          bookmaker: chosen.bookmaker ?? null,
          action: r.decision.action as "BET" | "NO_BET",
        };
      }).sort((a, b) => (b.ev_stressed ?? -1e9) - (a.ev_stressed ?? -1e9));
    }
    return call<BetSummary[]>(`/api/bets${qs({ league, season })}`);
  },
  replay: (matchId: string, modelId?: string, o?: Overrides, policyId: ReplayPolicy = "controlled") =>
    USE_MOCKS
      ? mock<ReplayX>("replay")
      : call<ReplayX>(`/api/replay/${encodeURIComponent(matchId)}${qs({ model_id: modelId, policy_id: policyId, ...o })}`),
  reveal: (matchId: string, modelId?: string, policyId: ReplayPolicy = "controlled") =>
    USE_MOCKS
      ? mock<RevealX>("reveal")
      : call<RevealX>(`/api/replay/${encodeURIComponent(matchId)}/reveal${qs({ model_id: modelId, policy_id: policyId })}`),
  evidence: (modelId?: string, split?: string) =>
    USE_MOCKS ? mock<EvidenceX>("evidence") : call<EvidenceX>(`/api/evidence${qs({ model_id: modelId, split })}`),
  audit: () => (USE_MOCKS ? mock<Audit>("audit") : call<Audit>("/api/audit")),
  scenarios: () => (USE_MOCKS ? mock<Scenarios>("scenarios") : call<Scenarios>("/api/scenarios")),
  explain: (matchId: string, modelId?: string, o?: Overrides, policyId: ReplayPolicy = "controlled") =>
    USE_MOCKS
      ? mock<Explain>("explain")
      : call<Explain>(`/api/explain/${encodeURIComponent(matchId)}${qs({ model_id: modelId, policy_id: policyId, ...o })}`, { method: "POST" }),
};

// Tiny data hook: { data, error, loading } with stale-response protection.
import { useEffect, useRef, useState } from "react";

export function useApi<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null, error: null, loading: true,
  });
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setState({ data: null, loading: true, error: null });
    fn().then(
      (data) => id === seq.current && setState({ data, error: null, loading: false }),
      (err: unknown) =>
        id === seq.current &&
        setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false }),
    );
    return () => { ++seq.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
