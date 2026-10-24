// Local EXTENSIONS of the contract shapes (never redefinitions). The backend adds a few
// optional `x_` keys, following the contract's convention for extras.
import type { Evidence, Replay, Reveal } from "../../../contract/api_types";

export type ReplayPolicy = "controlled" | "controlled_best_price";

// Optional consumer extension until Ricky adds line_shopping to the shared API type.
// These values are passed through from his artifact, never calculated in the app.
export type LineShopping = Record<string, unknown>;

export type ReplayX = Replay & {
  x_decision_source?: "ledger" | "live";
  x_quote_is_valid?: boolean | null;
  x_notes?: string[];
};

export type RevealX = Reveal & { x_model_id?: string | null; x_notes?: string[] };

export type EvidenceX = Evidence & {
  x_models?: string[];
  x_config_hash?: string | null;
  x_locked_at_utc?: string | null;
  x_model_version?: string | null;
  x_brier_convention?: string;
  x_policy_note?: string | null;
  x_notes?: string[];
  x_line_shopping?: LineShopping | null;
};

export type Overrides = { prob_stress_delta?: number; price_haircut?: number; min_ev?: number };

export type Mode = "normal" | "advanced";
