// Display formatting only. Missing numbers render as "n/a", never 0 (SPEC section 4).
export const NA = "n/a";

const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

export const pct = (x: number | null | undefined, d = 1) => (ok(x) ? `${(x * 100).toFixed(d)}%` : NA);

const MINUS = "−";
export const spct = (x: number | null | undefined, d = 1) =>
  ok(x) ? `${x >= 0 ? "+" : MINUS}${Math.abs(x * 100).toFixed(d)}%` : NA;

export const spp = (x: number | null | undefined, d = 1) =>
  ok(x) ? `${x >= 0 ? "+" : MINUS}${Math.abs(x * 100).toFixed(d)} pp` : NA;

export const odds = (x: number | null | undefined) => (ok(x) ? x.toFixed(2) : NA);

export const fix = (x: number | null | undefined, d = 3) => (ok(x) ? x.toFixed(d) : NA);

export const sfix = (x: number | null | undefined, d = 3) =>
  ok(x) ? `${x >= 0 ? "+" : MINUS}${Math.abs(x).toFixed(d)}` : NA;

export const units = (x: number | null | undefined, d = 2) => (ok(x) ? `${x.toFixed(d)} units` : NA);

export const sunits = (x: number | null | undefined, d = 2) =>
  ok(x) ? `${x >= 0 ? "+" : MINUS}${Math.abs(x).toFixed(d)} units` : NA;

export const int = (x: number | null | undefined) => (ok(x) ? Math.round(x).toLocaleString("en-GB") : NA);

const dtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const df = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });

export const when = (iso: string | null | undefined) => (iso ? `${dtf.format(new Date(iso))} UTC` : NA);
export const day = (iso: string | null | undefined) => (iso ? df.format(new Date(iso)) : NA);

export const isNum = ok;
