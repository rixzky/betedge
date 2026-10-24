export const PROJECT_TITLE = "BetEdge";
export const PROJECT_SUBTITLE = "Find mispriced odds";

export const HOLDOUT_SEASON = "2025-26";

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === "1";

export const OUTCOME_LABEL: Record<"H" | "D" | "A", string> = { H: "Home win", D: "Draw", A: "Away win" };

export const MODEL_LABEL: Record<string, string> = {
  market: "Market (baseline)",
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
