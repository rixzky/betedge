// The team has not chosen a project name yet (CONTRACT section header). Change these two lines
// when it does; nothing else in the UI hardcodes a name.
export const PROJECT_TITLE = "Does the edge survive?";
export const PROJECT_SUBTITLE = "Football odds research · paper trading only";

// Contract constant (contract/schemas.py HOLDOUT_SEASON). Used only to hide the holdout
// season from selectors until /api/meta says holdout_locked.
export const HOLDOUT_SEASON = "2025-26";

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === "1";

export const OUTCOME_LABEL: Record<"H" | "D" | "A", string> = { H: "Home", D: "Draw", A: "Away" };

export const MODEL_LABEL: Record<string, string> = {
  market: "Market (margin-free)",
  elo: "Elo",
  dixon_coles: "Dixon-Coles",
  marketnet: "MarketNet",
  lgbm: "LightGBM",
};

export const LEAGUE_LABEL: Record<string, string> = {
  E0: "England · Premier League",
  E1: "England · Championship",
  SP1: "Spain · La Liga",
  D1: "Germany · Bundesliga",
  I1: "Italy · Serie A",
  F1: "France · Ligue 1",
  N1: "Netherlands · Eredivisie",
  P1: "Portugal · Primeira Liga",
};
