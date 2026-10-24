// Pitch geometry in metres (Laws of the Game, 105 × 68 m) and the research destinations
// that live on real field components. Pure data: no React, no DOM, so it can be unit-checked.
import type { Screen } from "../route";

export const L = 105; // length (goal line to goal line)
export const W = 68; // width (touchline to touchline)
export const MX = 7; // run-off behind each goal line, metres (goals + labels)
export const MY = 6; // run-off beyond each touchline, metres

export const PEN_DEPTH = 16.5;
export const PEN_WIDTH = 40.32;
export const GOAL_AREA_DEPTH = 5.5;
export const GOAL_AREA_WIDTH = 18.32;
export const GOAL_WIDTH = 7.32;
export const GOAL_DEPTH = 2;
export const CIRCLE_R = 9.15;
export const SPOT = 11;
export const CORNER_R = 1;

export type Vec = { x: number; y: number };
export type Orientation = "landscape" | "portrait";

/** Stage size in metres (field + run-off) for an orientation. */
export function stageSize(o: Orientation) {
  const w = L + 2 * MX;
  const h = W + 2 * MY;
  return o === "landscape" ? { w, h } : { w: h, h: w };
}

/**
 * Field metres -> fraction (0..1) of the rendered stage. Portrait rotates the field 90°
 * clockwise, so the left goal sits at the top. Used by the canvas, the SVG layer and HTML labels.
 */
export function toFraction(p: Vec, o: Orientation): Vec {
  const fx = (p.x + MX) / (L + 2 * MX);
  const fy = (p.y + MY) / (W + 2 * MY);
  return o === "landscape" ? { x: fx, y: fy } : { x: 1 - fy, y: fx };
}

/** Inverse of toFraction. */
export function fromFraction(f: Vec, o: Orientation): Vec {
  const fx = o === "landscape" ? f.x : f.y;
  const fy = o === "landscape" ? f.y : 1 - f.x;
  return { x: fx * (L + 2 * MX) - MX, y: fy * (W + 2 * MY) - MY };
}

export type DestId =
  | "flag-map" | "flag-replay" | "flag-evidence" | "flag-audit"
  | "box-left" | "box-right" | "goal-left" | "goal-right" | "centre" | "halfway";

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; cx: number; cy: number; r: number };

export interface Destination {
  id: DestId;
  component: string; // the physical field component, for labels and screen readers
  title: string; // the research destination
  detail: string; // what opens
  screen: Exclude<Screen, "home">;
  params: Record<string, string>;
  anchor: Vec; // where the ball travels and the passing lane ends
  hit: Shape; // generous pointer target (metres)
}

const PEN_Y = (W - PEN_WIDTH) / 2;
const GOAL_Y = (W - GOAL_WIDTH) / 2;

// Order = keyboard tab order: corners clockwise from top-left, then the field from left to right.
export const DESTINATIONS: Destination[] = [
  { id: "flag-map", component: "Top-left corner flag", title: "Market Trends", detail: "League by season heat map of bookmaker accuracy",
    screen: "map", params: {}, anchor: { x: 1.2, y: 1.2 }, hit: { kind: "circle", cx: 0, cy: 0, r: 4.5 } },
  { id: "flag-replay", component: "Top-right corner flag", title: "Match Replay", detail: "Pick a fixture and see our forecast vs the bookmaker",
    screen: "replay", params: {}, anchor: { x: L - 1.2, y: 1.2 }, hit: { kind: "circle", cx: L, cy: 0, r: 4.5 } },
  { id: "flag-evidence", component: "Bottom-right corner flag", title: "The Evidence", detail: "How accurate are our predictions? See the track record",
    screen: "evidence", params: {}, anchor: { x: L - 1.2, y: W - 1.2 }, hit: { kind: "circle", cx: L, cy: W, r: 4.5 } },
  { id: "flag-audit", component: "Bottom-left corner flag", title: "Data Audit", detail: "What data was used and what was excluded",
    screen: "audit", params: {}, anchor: { x: 1.2, y: W - 1.2 }, hit: { kind: "circle", cx: 0, cy: W, r: 4.5 } },
  { id: "box-left", component: "Left penalty area", title: "Data Quality", detail: "Check for flagged or excluded data",
    screen: "audit", params: {}, anchor: { x: SPOT, y: W / 2 }, hit: { kind: "rect", x: 0, y: PEN_Y, w: PEN_DEPTH, h: PEN_WIDTH } },
  { id: "goal-left", component: "Left goal", title: "Bookmaker Prices", detail: "See the prices offered for this match",
    screen: "replay", params: {}, anchor: { x: -1.2, y: W / 2 }, hit: { kind: "rect", x: -4.2, y: GOAL_Y - 2.2, w: 4.2, h: GOAL_WIDTH + 4.4 } },
  { id: "centre", component: "Centre circle", title: "Best Value Bets", detail: "Matches where our model thinks the bookmaker has mispriced the odds",
    screen: "bets", params: {}, anchor: { x: L / 2, y: W / 2 }, hit: { kind: "circle", cx: L / 2, cy: W / 2, r: CIRCLE_R } },
  { id: "halfway", component: "Halfway line", title: "Compare Models", detail: "Side by side model accuracy",
    screen: "evidence", params: {}, anchor: { x: L / 2, y: 7 }, hit: { kind: "rect", x: L / 2 - 1.6, y: 0, w: 3.2, h: W } },
  { id: "box-right", component: "Right penalty area", title: "Stress the Model", detail: "What-if scenarios for this decision",
    screen: "replay", params: {}, anchor: { x: L - SPOT, y: W / 2 }, hit: { kind: "rect", x: L - PEN_DEPTH, y: PEN_Y, w: PEN_DEPTH, h: PEN_WIDTH } },
  { id: "goal-right", component: "Right goal", title: "Track Record", detail: "Policy results and returns",
    screen: "evidence", params: {}, anchor: { x: L + 1.2, y: W / 2 }, hit: { kind: "rect", x: L, y: GOAL_Y - 2.2, w: 4.2, h: GOAL_WIDTH + 4.4 } },
];

export const destById = (id: string | null | undefined) => DESTINATIONS.find((d) => d.id === id) ?? null;

/** Is a field point inside any destination's hit area? (Open-grass clicks are the rest.) */
export function hitDestination(p: Vec): Destination | null {
  const order: DestId[] = ["flag-map", "flag-replay", "flag-evidence", "flag-audit", "goal-left", "goal-right", "centre", "box-left", "box-right", "halfway"];
  for (const id of order) {
    const d = destById(id)!;
    const s = d.hit;
    if (s.kind === "circle" ? (p.x - s.cx) ** 2 + (p.y - s.cy) ** 2 <= s.r ** 2
      : p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return d;
  }
  return null;
}
