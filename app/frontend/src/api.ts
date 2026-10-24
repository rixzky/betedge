// API client. With VITE_USE_MOCKS=1 every call is answered from contract/golden/api/*.json,
// so the UI works before the backend exists (SPEC section 4).
import type {
  Audit, EfficiencyMap, Explain, Fixture, Meta, Scenarios,
} from "../../../contract/api_types";
import { USE_MOCKS } from "./config";
import type { EvidenceX, Overrides, ReplayPolicy, ReplayX, RevealX } from "./types";

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
