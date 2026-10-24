// Pitch engine, adapted from the user-supplied reference canvas (referencePitch.js): 22 player
// markers, a passing move with network lines, shots, trails and a ball you can play or drag.
// Purely illustrative: it reads no research data and produces no research values.
//
// Differences from the reference, for the research workspace:
// - Deterministic: a seeded PRNG and a virtual clock (`state.t`, ms) replace Math.random and
//   performance.now, so a snapshot restores the exact positions, ball and passing sequence.
// - The clock advances only while frames run, so pausing (research open, offscreen, hidden tab,
//   user pause, reduced motion) never causes a timing jump on resume.
// - Field drawn in metres with an orientation transform (portrait on phones).
import { CIRCLE_R, CORNER_R, GOAL_AREA_DEPTH, GOAL_AREA_WIDTH, GOAL_DEPTH, GOAL_WIDTH, L, MX, MY, PEN_DEPTH, PEN_WIDTH, SPOT, W,
  fromFraction, stageSize, type Orientation, type Vec } from "./geometry";

// Reference formations (fractions of length u and width v). Team 0 attacks right.
const FH = [[.05, .5], [.22, .14], [.2, .38], [.2, .62], [.22, .86], [.42, .28], [.38, .5], [.42, .72], [.64, .16], [.7, .5], [.64, .84]];
const FA = [[.05, .5], [.22, .14], [.2, .38], [.2, .62], [.22, .86], [.4, .15], [.38, .38], [.38, .62], [.4, .85], [.6, .38], [.6, .62]];
const NUMBERS = [1, 2, 5, 6, 3, 8, 4, 10, 7, 9, 11];
const INTRO_MS = 800;

export interface Player { team: 0 | 1; gk: boolean; n: number; bu: number; bv: number; u: number; v: number; ph: number }
type Mode = "intro" | "hold" | "pass" | "shot" | "dead" | "kick" | "manual" | "dest";
export interface EngineState {
  t: number; rng: number; passes: number;
  players: Player[];
  ball: { u: number; v: number; mode: Mode; holder: number; t0: number; dur: number; fu: number; fv: number; tu: number; tv: number; toIdx: number; until: number; trail: { u: number; v: number; t: number }[] };
  ripple: { u: number; v: number; t: number } | null;
}

export function rand(s: EngineState) {
  let x = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

export function createState(seed = 2026, intro = true): EngineState {
  const s: EngineState = { t: 0, rng: seed | 0, passes: 0, players: [], ripple: null,
    ball: { u: .5, v: intro ? 1.1 : .5, mode: intro ? "intro" : "hold", holder: 6, t0: 0, dur: INTRO_MS, fu: .5, fv: 1.1, tu: .5, tv: .5, toIdx: 6, until: intro ? INTRO_MS + 450 : 600, trail: [] } };
  FH.forEach((p, i) => s.players.push({ team: 0, gk: i === 0, n: NUMBERS[i], bu: p[0], bv: p[1], u: p[0], v: p[1], ph: rand(s) * 6.283 }));
  FA.forEach((p, i) => s.players.push({ team: 1, gk: i === 0, n: NUMBERS[i], bu: 1 - p[0], bv: p[1], u: 1 - p[0], v: p[1], ph: rand(s) * 6.283 }));
  if (!intro) { s.players[6].u = .485; s.players[6].v = .5; s.ball.u = .497; s.ball.v = .51; }
  return s;
}

export const cloneState = (s: EngineState): EngineState => structuredClone(s);

const dirOf = (team: 0 | 1) => (team === 0 ? 1 : -1);

function decide(s: EngineState) {
  const b = s.ball;
  const h = s.players[b.holder];
  const dir = dirOf(h.team);
  b.t0 = s.t; b.fu = b.u; b.fv = b.v;
  const attacking = dir > 0 ? h.u > .7 : h.u < .3;
  if (attacking && rand(s) < .5) {
    b.mode = "shot"; b.tu = dir > 0 ? 1.0 : 0.0; b.tv = .5 + (rand(s) - .5) * .09; b.dur = 520;
    return;
  }
  const w: [number, number][] = [];
  let tot = 0;
  s.players.forEach((c, i) => {
    if (i === b.holder || c.team !== h.team) return;
    const d = Math.hypot((c.u - h.u) * L, (c.v - h.v) * W) / L;
    let wt = Math.exp(-d * 5) * (1 + Math.max(0, dir * (c.u - h.u)) * 3.5);
    if (c.gk && (dir > 0 ? h.u > .3 : h.u < .7)) wt *= .05;
    w.push([i, wt]); tot += wt;
  });
  let r = rand(s) * tot, best = w[0][0];
  for (const [i, wt] of w) { r -= wt; if (r <= 0) { best = i; break; } }
  const t = s.players[best];
  b.mode = "pass"; b.toIdx = best;
  b.dur = 300 + Math.hypot((t.u - h.u) * L, (t.v - h.v) * W) * 22;
}

function nearest(s: EngineState, u: number, v: number, team?: 0 | 1) {
  let bi = 1, bd = 9;
  s.players.forEach((p, i) => {
    if (p.gk || (team !== undefined && p.team !== team)) return;
    const d = Math.hypot(p.u - u, (p.v - v) * W / L);
    if (d < bd) { bd = d; bi = i; }
  });
  return bi;
}

export interface Pointer { u: number; v: number; on: boolean }

/** Advance the simulation by dt milliseconds of active time (clamped so a resume cannot jump). */
export function update(s: EngineState, rawDt: number, ptr?: Pointer) {
  const dt = Math.max(0, Math.min(50, rawDt));
  if (dt === 0) return;
  s.t += dt;
  const now = s.t;
  const b = s.ball;
  const shift = (b.u - .5) * .2;
  s.players.forEach((p, i) => {
    let tu = p.bu + (p.gk ? 0 : shift) + Math.sin(now * .0007 + p.ph) * .012;
    let tv = .5 + (p.bv - .5) * .94 + (b.v - .5) * (p.gk ? .25 : .1) + Math.cos(now * .0009 + p.ph * 1.7) * .016;
    if (b.mode === "intro" && i === 6) { tu = .485; tv = .5; }
    if (ptr?.on && !p.gk) {
      const dx = (ptr.u - p.u) * L, dy = (ptr.v - p.v) * W, d = Math.hypot(dx, dy), R = 13;
      if (d < R) { const f = Math.pow(1 - d / R, 2) * .5; tu += (dx / L) * f; tv += (dy / W) * f; }
    }
    const k = 1 - Math.exp(-dt * .006);
    p.u += (tu - p.u) * k; p.v += (tv - p.v) * k;
  });
  if (b.mode === "manual") return;
  const h = s.players[b.holder];
  const k = Math.min(1, (now - b.t0) / b.dur);
  const e = 1 - (1 - k) * (1 - k);
  if (b.mode === "intro") {
    b.u = b.fu + (b.tu - b.fu) * e; b.v = b.fv + (b.tv - b.fv) * e;
    if (k >= 1) { b.mode = "hold"; b.holder = 6; }
  } else if (b.mode === "hold") {
    const dir = dirOf(h.team);
    b.u = h.u + .012 * dir; b.v = h.v + .01;
    if (now > b.until) decide(s);
  } else if (b.mode === "pass") {
    const t = s.players[b.toIdx];
    b.u = b.fu + (t.u - b.fu) * e; b.v = b.fv + (t.v - b.fv) * e;
    if (k >= 1) { b.holder = b.toIdx; b.mode = "hold"; b.until = now + 300 + rand(s) * 380; s.passes++; }
  } else if (b.mode === "shot" || b.mode === "kick" || b.mode === "dest") {
    b.u = b.fu + (b.tu - b.fu) * e; b.v = b.fv + (b.tv - b.fv) * e;
    if (k >= 1) {
      if (b.mode === "shot") { s.ripple = { u: b.u, v: b.v, t: now }; b.mode = "dead"; b.until = now + 1100; }
      else if (b.mode === "kick") { b.holder = nearest(s, b.u, b.v); b.mode = "hold"; b.until = now + 420; }
      else b.mode = "manual"; // a destination shot rests until research closes and the snapshot returns
    }
  } else if (b.mode === "dead") {
    if (now > b.until) {
      const scorer = h.team;
      b.holder = scorer === 0 ? 13 : 2; // the other side restarts from a centre-back
      b.mode = "hold"; b.until = now + 500; b.trail.length = 0;
    }
  }
  b.trail.push({ u: b.u, v: b.v, t: now });
  while (b.trail.length && now - b.trail[0].t > 520) b.trail.shift();
}

export function kick(s: EngineState, u: number, v: number, ms = 380, mode: "kick" | "dest" = "kick") {
  const b = s.ball;
  b.mode = mode; b.t0 = s.t; b.dur = ms; b.fu = b.u; b.fv = b.v; b.tu = u; b.tv = v;
}

export function resetBall(s: EngineState) {
  const b = s.ball;
  b.trail.length = 0;
  b.holder = 6; b.u = s.players[6].u + .012; b.v = s.players[6].v + .01;
  kick(s, .5, .5, 260);
}

// ---------------------------------------------------------------- drawing
let grain: CanvasPattern | null = null;
function grainPattern(ctx: CanvasRenderingContext2D) {
  if (grain) return grain;
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d")!;
  const img = g.createImageData(96, 96);
  let seed = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const v = seed % 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 14;
  }
  g.putImageData(img, 0, 0);
  grain = ctx.createPattern(c, "repeat");
  return grain;
}

export interface DrawOpts {
  orientation: Orientation;
  lane: Vec | null; // destination anchor in metres
  aim: Vec | null; // crosshair in metres
  ptr: Pointer;
  dpr: number;
  reveal: number; // 0..1 opening line reveal
}

const CHALK = "rgba(243,241,229,.9)";
const LIME = "#DDEF9C";

export function draw(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, s: EngineState, o: DrawOpts) {
  const { w: SW } = stageSize(o.orientation);
  const S = cssW / SW; // px per metre
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // field transform: metres -> css px
  const fieldT = () => {
    ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
    if (o.orientation === "landscape") { ctx.translate(MX * S, MY * S); ctx.scale(S, S); }
    else { ctx.translate(cssW - MY * S, MX * S); ctx.rotate(Math.PI / 2); ctx.scale(S, S); }
  };
  fieldT();
  const px = 1 / S; // one css pixel in metres

  // run-off and turf
  ctx.fillStyle = "#0a4d3b";
  ctx.fillRect(-MX, -MY, L + 2 * MX, W + 2 * MY);
  const n = 18;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? "#0d6449" : "#106c50";
    ctx.fillRect(-MX + ((L + 2 * MX) * i) / n, -MY, (L + 2 * MX) / n + px, W + 2 * MY);
  }
  // run-off slightly darker than the field of play
  ctx.fillStyle = "rgba(4,32,24,.30)";
  ctx.fillRect(-MX, -MY, L + 2 * MX, MY); ctx.fillRect(-MX, W, L + 2 * MX, MY);
  ctx.fillRect(-MX, 0, MX, W); ctx.fillRect(L, 0, MX, W);
  // floodlight falloff (restrained)
  const vg = ctx.createRadialGradient(L / 2, W / 2, W * .25, L / 2, W / 2, L * .72);
  vg.addColorStop(0, "rgba(6,29,23,0)"); vg.addColorStop(1, "rgba(6,29,23,.42)");
  ctx.fillStyle = vg; ctx.fillRect(-MX, -MY, L + 2 * MX, W + 2 * MY);
  ctx.save(); ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0); const gp = grainPattern(ctx); if (gp) { ctx.fillStyle = gp; ctx.fillRect(0, 0, cssW, cssH); } ctx.restore();
  fieldT();

  // markings, revealed outward from the centre spot during the opening
  const reach = (1 - Math.pow(1 - o.reveal, 3)) * Math.hypot(L, W) * .62;
  ctx.save();
  ctx.beginPath(); ctx.arc(L / 2, W / 2, Math.max(.01, reach), 0, 6.2832); ctx.clip();
  ctx.lineWidth = Math.max(1.35 * px, .12);
  ctx.strokeStyle = CHALK; ctx.lineCap = "butt";
  ctx.strokeRect(0, 0, L, W);
  const line = (a: number, b: number, c: number, d: number) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); };
  const arc = (x: number, y: number, r: number, a0: number, a1: number) => { ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke(); };
  const spot = (x: number, y: number, r = .22) => { ctx.beginPath(); ctx.arc(x, y, Math.max(r, 1.6 * px), 0, 6.2832); ctx.fillStyle = CHALK; ctx.fill(); };
  line(L / 2, 0, L / 2, W);
  arc(L / 2, W / 2, CIRCLE_R, 0, 6.2832); spot(L / 2, W / 2, .3);
  const py = (W - PEN_WIDTH) / 2, gy = (W - GOAL_AREA_WIDTH) / 2;
  ctx.strokeRect(0, py, PEN_DEPTH, PEN_WIDTH); ctx.strokeRect(L - PEN_DEPTH, py, PEN_DEPTH, PEN_WIDTH);
  ctx.strokeRect(0, gy, GOAL_AREA_DEPTH, GOAL_AREA_WIDTH); ctx.strokeRect(L - GOAL_AREA_DEPTH, gy, GOAL_AREA_DEPTH, GOAL_AREA_WIDTH);
  spot(SPOT, W / 2); spot(L - SPOT, W / 2);
  const a = Math.acos((PEN_DEPTH - SPOT) / CIRCLE_R);
  arc(SPOT, W / 2, CIRCLE_R, -a, a); arc(L - SPOT, W / 2, CIRCLE_R, Math.PI - a, Math.PI + a);
  arc(0, 0, CORNER_R, 0, Math.PI / 2); arc(L, 0, CORNER_R, Math.PI / 2, Math.PI);
  arc(L, W, CORNER_R, Math.PI, Math.PI * 1.5); arc(0, W, CORNER_R, Math.PI * 1.5, Math.PI * 2);
  // goals: fine netting, posts and crossbar seen from above
  const goalY = (W - GOAL_WIDTH) / 2;
  for (const side of [0, 1]) {
    const x0 = side === 0 ? -GOAL_DEPTH : L, x1 = side === 0 ? 0 : L + GOAL_DEPTH;
    ctx.save();
    ctx.fillStyle = "rgba(3,22,17,.35)"; ctx.fillRect(x0, goalY, GOAL_DEPTH, GOAL_WIDTH);
    ctx.lineWidth = Math.max(.7 * px, .03); ctx.strokeStyle = "rgba(243,241,229,.30)";
    for (let y = goalY; y <= goalY + GOAL_WIDTH + 1e-6; y += .33) line(x0, y, x1, y);
    for (let x = x0; x <= x1 + 1e-6; x += .33) line(x, goalY, x, goalY + GOAL_WIDTH);
    ctx.restore();
    ctx.save(); ctx.lineWidth = Math.max(2.4 * px, .2); ctx.strokeStyle = "#F3F1E5";
    const back = side === 0 ? x0 : x1, front = side === 0 ? x1 : x0;
    ctx.beginPath(); ctx.moveTo(front, goalY); ctx.lineTo(back, goalY); ctx.lineTo(back, goalY + GOAL_WIDTH); ctx.lineTo(front, goalY + GOAL_WIDTH); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  const X = (u: number) => u * L, Y = (v: number) => v * W;
  const fade = Math.min(1, s.t / 500);
  const b = s.ball;
  const possession = s.players[b.holder]?.team ?? 0;

  // passing network of the side in possession
  ctx.lineWidth = Math.max(1 * px, .06);
  for (let i = 0; i < 22; i++) for (let j = i + 1; j < 22; j++) {
    const p = s.players[i], q = s.players[j];
    if (p.team !== possession || q.team !== possession) continue;
    const d = Math.hypot((p.u - q.u) * L, (p.v - q.v) * W) / L;
    if (d < .26) {
      ctx.strokeStyle = `rgba(243,241,229,${(1 - d / .26) * .16 * fade})`;
      line(X(p.u), Y(p.v), X(q.u), Y(q.v));
    }
  }
  if (b.mode === "pass") {
    const tp = s.players[b.toIdx];
    ctx.strokeStyle = "rgba(243,241,229,.5)"; ctx.lineWidth = Math.max(2 * px, .12);
    line(X(b.fu), Y(b.fv), X(tp.u), Y(tp.v));
  }

  // tactical crosshair (pointer or keyboard aim)
  const aim = o.aim ?? (o.ptr.on ? { x: X(o.ptr.u), y: Y(o.ptr.v) } : null);
  if (aim) {
    const g = ctx.createRadialGradient(aim.x, aim.y, 0, aim.x, aim.y, 12);
    g.addColorStop(0, "rgba(221,239,156,.16)"); g.addColorStop(1, "rgba(221,239,156,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(aim.x, aim.y, 12, 0, 6.2832); ctx.fill();
    ctx.save();
    ctx.strokeStyle = "rgba(221,239,156,.85)"; ctx.lineWidth = Math.max(1.4 * px, .08);
    ctx.setLineDash([.9, 1.1]); ctx.lineDashOffset = -s.t * .0015;
    ctx.beginPath(); ctx.arc(aim.x, aim.y, 4.2, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
    for (let k = 0; k < 4; k++) {
      const ang = k * Math.PI / 2;
      line(aim.x + Math.cos(ang) * 5, aim.y + Math.sin(ang) * 5, aim.x + Math.cos(ang) * 6.6, aim.y + Math.sin(ang) * 6.6);
    }
    ctx.restore();
  }

  // passing lane to a hovered or focused destination
  if (o.lane) {
    ctx.save();
    ctx.strokeStyle = LIME; ctx.lineWidth = Math.max(2 * px, .14); ctx.lineCap = "round";
    ctx.setLineDash([1.1, 1.1]); ctx.lineDashOffset = -s.t * .004;
    line(X(b.u), Y(b.v), o.lane.x, o.lane.y);
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(o.lane.x, o.lane.y, 1.1, 0, 6.2832); ctx.stroke();
    ctx.restore();
  }

  // players
  const r = Math.max(5.5 * px, 1.05);
  ctx.globalAlpha = fade;
  s.players.forEach((p, i) => {
    const x = X(p.u), y = Y(p.v);
    ctx.fillStyle = "rgba(2,16,12,.32)";
    ctx.beginPath(); ctx.ellipse(x + r * .28, y + r * .42, r * 1.02, r * .8, 0, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    ctx.fillStyle = p.team === 0 ? (p.gk ? LIME : "#F3F1E5") : (p.gk ? "#2a3a22" : "#0B2B21");
    ctx.fill();
    ctx.lineWidth = Math.max(1.5 * px, .1);
    ctx.strokeStyle = p.team === 0 ? "#061D17" : (p.gk ? "#E8B65A" : "#F3F1E5");
    ctx.stroke();
    if (r / px >= 7.5) {
      ctx.save();
      ctx.translate(x, y);
      if (o.orientation === "portrait") ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = p.team === 0 ? "#061D17" : "#F3F1E5";
      ctx.font = `700 ${r * 1.12}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(p.n), 0, r * .06);
      ctx.restore();
    }
    if (b.mode === "hold" && i === b.holder) {
      ctx.strokeStyle = "rgba(221,239,156,.9)"; ctx.lineWidth = Math.max(1.5 * px, .1);
      ctx.beginPath(); ctx.arc(x, y, r + .55 + Math.sin(s.t * .008) * .16, 0, 6.2832); ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;

  // ball trail and ball
  ctx.lineCap = "round";
  for (let i = 1; i < b.trail.length; i++) {
    const p0 = b.trail[i - 1], p1 = b.trail[i];
    const age = 1 - (s.t - p1.t) / 520;
    ctx.strokeStyle = `rgba(243,241,229,${Math.max(0, age) * .75})`;
    ctx.lineWidth = Math.max((1 + age * 3) * px, .06);
    line(X(p0.u), Y(p0.v), X(p1.u), Y(p1.v));
  }
  const bx = X(b.u), by = Y(b.v), br = r * .68;
  ctx.fillStyle = "rgba(2,16,12,.35)"; ctx.beginPath(); ctx.ellipse(bx + br * .35, by + br * .45, br, br * .75, 0, 0, 6.2832); ctx.fill();
  ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.2832); ctx.fillStyle = "#FFFFFF"; ctx.fill();
  ctx.lineWidth = Math.max(1.2 * px, .07); ctx.strokeStyle = "#061D17"; ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * 6.283 - 1.57 + s.t * .002;
    const x = bx + Math.cos(ang) * br * .45, y = by + Math.sin(ang) * br * .45;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath(); ctx.fillStyle = "#061D17"; ctx.fill();

  if (s.ripple) {
    const k = (s.t - s.ripple.t) / 1000;
    if (k < 1) {
      ctx.strokeStyle = `rgba(243,241,229,${1 - k})`; ctx.lineWidth = Math.max(2 * px, .12);
      ctx.beginPath(); ctx.arc(X(s.ripple.u), Y(s.ripple.v), 1 + k * 7, 0, 6.2832); ctx.stroke();
    } else s.ripple = null;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** CSS-pixel point inside the canvas -> field metres. */
export function pointToField(x: number, y: number, cssW: number, cssH: number, o: Orientation): Vec {
  return fromFraction({ x: x / cssW, y: y / cssH }, o);
}

export const INTRO = INTRO_MS;
