import { useCallback, useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import {
  CIRCLE_R, DESTINATIONS, GOAL_DEPTH, GOAL_WIDTH, L, MX, MY, PEN_DEPTH, PEN_WIDTH, W, stageSize, toFraction,
  type Destination, type DestId, type Orientation, type Vec,
} from "./geometry";
import { INTRO, cloneState, createState, draw, kick, pointToField, resetBall, update, type EngineState, type Pointer } from "./engine";

type PauseReason = "research" | "offscreen" | "hidden" | "user";

function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOn(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return on;
}

// Persistent, painted-on labels. `at` is a field point (metres); `place` anchors the text there.
type Paint = { text: string; num?: string; at: Vec; place: "c" | "e" | "w" };
const PAINT: Record<DestId, Paint> = {
  "flag-map": { num: "01", text: "Market Trends", at: { x: 3.2, y: -3.1 }, place: "e" },
  "flag-replay": { num: "02", text: "Match Replay", at: { x: L - 3.2, y: -3.1 }, place: "w" },
  "flag-evidence": { num: "03", text: "Evidence", at: { x: L - 3.2, y: W + 3.1 }, place: "w" },
  "flag-audit": { num: "04", text: "Data Audit", at: { x: 3.2, y: W + 3.1 }, place: "e" },
  "box-left": { text: "Data Quality", at: { x: PEN_DEPTH / 2, y: (W - PEN_WIDTH) / 2 + 2.6 }, place: "c" },
  "box-right": { text: "Stress Test", at: { x: L - PEN_DEPTH / 2, y: (W - PEN_WIDTH) / 2 + 2.6 }, place: "c" },
  "goal-left": { text: "Prices", at: { x: -4.6, y: W / 2 + GOAL_WIDTH / 2 + 3.4 }, place: "c" },
  "goal-right": { text: "Results", at: { x: L + 4.6, y: W / 2 + GOAL_WIDTH / 2 + 3.4 }, place: "c" },
  centre: { text: "Best Bets", at: { x: L / 2, y: W / 2 + 2.7 }, place: "c" },
  halfway: { text: "Compare", at: { x: L / 2, y: -3.1 }, place: "c" },
};
// Portrait (phones): the side run-off is narrow, so labels move to the end strips or inside the field.
const PAINT_PORTRAIT: Record<DestId, Paint> = {
  "flag-map": { num: "01", text: "Trends", at: { x: -3.6, y: 4 }, place: "w" },
  "flag-audit": { num: "04", text: "Audit", at: { x: -3.6, y: W - 4 }, place: "e" },
  "goal-left": { text: "Prices", at: { x: -3.6, y: W / 2 }, place: "c" },
  "flag-replay": { num: "02", text: "Replay", at: { x: L + 3.6, y: 4 }, place: "w" },
  "flag-evidence": { num: "03", text: "Evidence", at: { x: L + 3.6, y: W - 4 }, place: "e" },
  "goal-right": { text: "Results", at: { x: L + 3.6, y: W / 2 }, place: "c" },
  "box-left": { text: "Data", at: { x: PEN_DEPTH - 2.4, y: W / 2 + 10.5 }, place: "c" },
  "box-right": { text: "Stress", at: { x: L - PEN_DEPTH + 2.4, y: W / 2 + 10.5 }, place: "c" },
  centre: { text: "Best Bets", at: { x: L / 2 + 3, y: W / 2 }, place: "c" },
  halfway: { text: "Compare", at: { x: L / 2 - 2, y: W / 2 + CIRCLE_R + 3 }, place: "w" },
};

export interface PitchProps {
  researchOpen: boolean;
  onOpen: (dest: Destination, opener: Element | null) => void;
  activeDest?: DestId | null;
}

/**
 * The interactive overhead pitch. One requestAnimationFrame loop draws the canvas; React state
 * changes only on hover/focus. The loop stops completely while research is open, the pitch is
 * offscreen, the tab is hidden, play is paused, or reduced motion is requested.
 */
export function Pitch({ researchOpen, onOpen, activeDest }: PitchProps) {
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const portrait = useMedia("(max-width: 700px)");
  const orientation: Orientation = portrait ? "portrait" : "landscape";
  const size = stageSize(orientation);

  const state = useRef<EngineState>(null as unknown as EngineState);
  if (state.current === null) state.current = createState(2026, !reduced);
  const saved = useRef<EngineState | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const dims = useRef({ w: 0, h: 0, dpr: 1 });
  const raf = useRef<number | null>(null);
  const last = useRef<number | null>(null);
  const reasons = useRef(new Set<PauseReason>());
  const ptr = useRef<Pointer>({ u: 0, v: 0, on: false });
  const aim = useRef<Vec | null>(null);
  const lane = useRef<Vec | null>(null);
  const drag = useRef<{ id: number; moved: boolean; onBall: boolean } | null>(null);
  const pending = useRef<{ dest: Destination; opener: Element | null; timer: number } | null>(null);
  const orient = useRef(orientation);
  orient.current = orientation;

  const [hot, setHot] = useState<Destination | null>(null);
  const [motion, setMotion] = useState(!reduced);
  const motionRef = useRef(motion);
  motionRef.current = motion;

  const paint = useCallback(() => {
    const c = canvas.current;
    if (!c || !dims.current.w) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const s = state.current;
    const reveal = reduced ? 1 : Math.min(1, s.t / INTRO);
    draw(ctx, dims.current.w, dims.current.h, s, {
      orientation: orient.current, lane: pending.current ? null : lane.current, aim: aim.current,
      ptr: ptr.current, dpr: dims.current.dpr, reveal,
    });
    c.dataset.simTime = s.t.toFixed(3);
    c.dataset.passes = String(s.passes);
    c.dataset.ball = `${(s.ball.u * L).toFixed(2)},${(s.ball.v * W).toFixed(2)}`;
    c.dataset.mode = s.ball.mode;
    c.dataset.lane = lane.current && !pending.current ? `${lane.current.x},${lane.current.y}` : "";
  }, [reduced]);

  const fire = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    window.clearTimeout(p.timer);
    pending.current = null;
    onOpen(p.dest, p.opener);
  }, [onOpen]);

  const frame = useCallback((now: number) => {
    raf.current = null;
    const shot = !!pending.current;
    if (!shot && reasons.current.size) { last.current = null; return; }
    const dt = last.current === null ? 0 : now - last.current;
    last.current = now;
    update(state.current, dt, ptr.current);
    paint();
    if (shot && state.current.ball.mode === "manual") { fire(); last.current = null; return; }
    raf.current = window.requestAnimationFrame(frame);
  }, [paint, fire]);

  const sync = useCallback(() => {
    if (canvas.current) canvas.current.dataset.paused = [...reasons.current].join(" ");
    const run = reasons.current.size === 0 || !!pending.current;
    if (run && raf.current === null) { last.current = null; raf.current = window.requestAnimationFrame(frame); }
    if (!run && raf.current !== null) { window.cancelAnimationFrame(raf.current); raf.current = null; last.current = null; }
  }, [frame]);

  const setReason = useCallback((r: PauseReason, on: boolean) => {
    if (on) reasons.current.add(r); else reasons.current.delete(r);
    sync();
  }, [sync]);

  // size the canvas to its box (HiDPI, capped at 2x)
  useEffect(() => {
    const c = canvas.current, b = box.current;
    if (!c || !b) return;
    const ro = new ResizeObserver(() => {
      const r = b.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      dims.current = { w: r.width, h: r.height, dpr };
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      paint();
    });
    ro.observe(b);
    return () => ro.disconnect();
  }, [paint, orientation]);

  useEffect(() => {
    const onVis = () => setReason("hidden", document.visibilityState === "hidden");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver(([e]) => setReason("offscreen", !e.isIntersecting), { threshold: 0.02 });
    if (box.current) io.observe(box.current);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
      if (raf.current !== null) window.cancelAnimationFrame(raf.current);
      raf.current = null;
      if (pending.current) window.clearTimeout(pending.current.timer);
    };
  }, [setReason]);

  useEffect(() => {
    if (reduced) setMotion(false);
  }, [reduced]);
  useEffect(() => { setReason("user", !motion); paint(); }, [motion, setReason, paint]);

  // research open: freeze; closed: restore the exact pre-shot state and continue with no jump
  useEffect(() => {
    const b = box.current;
    if (researchOpen) {
      setReason("research", true);
      lane.current = null;
      setHot(null);
      paint();
      // camera move: the frozen pitch fills the viewport behind the research workspace
      if (b && !reduced) {
        b.style.transition = "none";
        b.style.transform = "";
        const r = b.getBoundingClientRect(); // measured untransformed, so a re-run cannot compound
        void b.offsetWidth;
        b.style.transition = "";
        const sc = Math.max(window.innerWidth / r.width, window.innerHeight / r.height) * 1.06;
        b.style.transform = `translate(${window.innerWidth / 2 - (r.left + r.width / 2)}px, ${window.innerHeight / 2 - (r.top + r.height / 2)}px) scale(${sc.toFixed(3)})`;
      }
      return;
    }
    if (b) b.style.transform = "";
    if (saved.current) {
      state.current = saved.current;
      saved.current = null;
      if (canvas.current) canvas.current.dataset.restoredFrom = state.current.t.toFixed(3);
    }
    lane.current = null;
    setHot(null);
    paint();
    setReason("research", false);
  }, [researchOpen, setReason, paint, reduced]);

  const activate = (dest: Destination, opener: Element | null) => {
    if (pending.current || researchOpen) return;
    saved.current = cloneState(state.current);
    if (reduced || !motion) { onOpen(dest, opener); return; }
    kick(state.current, dest.anchor.x / L, dest.anchor.y / W, 200, "dest");
    pending.current = { dest, opener, timer: window.setTimeout(fire, 350) };
    sync();
  };

  // ---------------------------------------------------------------- grass interaction (canvas)
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return pointToField(e.clientX - r.left, e.clientY - r.top, r.width, r.height, orient.current);
  };
  const playTo = (p: Vec) => {
    const s = state.current;
    const u = Math.max(0.005, Math.min(0.995, p.x / L)), v = Math.max(0.01, Math.min(0.99, p.y / W));
    if (reduced || !motion) { s.ball.u = u; s.ball.v = v; s.ball.mode = "manual"; s.ball.trail.length = 0; paint(); return; }
    kick(s, u, v, 380);
  };
  const nearDest = (p: Vec) => DESTINATIONS.map((d) => ({ d, k: Math.hypot(d.anchor.x - p.x, d.anchor.y - p.y) })).sort((a, b) => a.k - b.k)[0];

  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || researchOpen) return;
    const p = local(e);
    const b = state.current.ball;
    const onBall = Math.hypot(p.x - b.u * L, p.y - b.v * W) < 3.2;
    drag.current = { id: e.pointerId, moved: false, onBall };
    if (onBall) { e.currentTarget.setPointerCapture(e.pointerId); b.mode = "manual"; b.trail.length = 0; }
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    ptr.current = { u: p.x / L, v: p.y / W, on: true };
    const d = drag.current;
    if (d?.onBall) {
      d.moved = true;
      const b = state.current.ball;
      b.u = Math.max(0, Math.min(1, p.x / L)); b.v = Math.max(0, Math.min(1, p.y / W));
    }
    if (reasons.current.size) paint();
  };
  const onUp = (e: RPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = local(e);
    if (d.onBall) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      const near = nearDest(p);
      if (d.moved && near.k < 6) { activate(near.d, null); return; }
      const s = state.current;
      if (reduced || !motion) { paint(); return; }
      s.ball.holder = s.players.reduce((bi, pl, i) => (!pl.gk && Math.hypot(pl.u - s.ball.u, pl.v - s.ball.v) < Math.hypot(s.players[bi].u - s.ball.u, s.players[bi].v - s.ball.v) ? i : bi), 1);
      s.ball.mode = "hold"; s.ball.until = s.t + 500;
      return;
    }
    playTo(p);
  };
  const onLeave = () => { ptr.current = { ...ptr.current, on: false }; if (reasons.current.size) paint(); };

  const onKey = (e: RKeyboardEvent<HTMLCanvasElement>) => {
    const s = state.current;
    const cur = aim.current ?? { x: s.ball.u * L, y: s.ball.v * W };
    const n = e.shiftKey ? 10 : 3;
    const map: Record<string, Vec> = orientation === "portrait"
      ? { ArrowUp: { x: -n, y: 0 }, ArrowDown: { x: n, y: 0 }, ArrowLeft: { x: 0, y: n }, ArrowRight: { x: 0, y: -n } }
      : { ArrowUp: { x: 0, y: -n }, ArrowDown: { x: 0, y: n }, ArrowLeft: { x: -n, y: 0 }, ArrowRight: { x: n, y: 0 } };
    if (map[e.key]) {
      e.preventDefault();
      aim.current = { x: Math.max(0.5, Math.min(L - 0.5, cur.x + map[e.key].x)), y: Math.max(0.5, Math.min(W - 0.5, cur.y + map[e.key].y)) };
      paint();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      playTo(cur);
      aim.current = null;
      paint();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      doReset();
    }
  };

  const doReset = () => {
    const s = state.current;
    if (reduced || !motion) { s.ball.u = .5; s.ball.v = .5; s.ball.mode = "manual"; s.ball.trail.length = 0; aim.current = null; paint(); return; }
    resetBall(s);
    aim.current = null;
  };

  const enter = (d: Destination) => { lane.current = d.anchor; setHot(d); paint(); };
  const leave = (d: Destination) => { if (hot?.id === d.id || lane.current === d.anchor) { lane.current = null; setHot(null); paint(); } };
  const destKey = (d: Destination) => (e: RKeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(d, e.currentTarget); }
  };

  const T = orientation === "landscape" ? `translate(${MX} ${MY})` : `translate(${W + MY} ${MX}) rotate(90)`;
  const card = hot ? toFraction(hot.anchor, orientation) : null;

  return (
    <div className={`pitch-stage ${orientation}`}>
      <div ref={box} className="pitch-box" style={{ aspectRatio: `${size.w} / ${size.h}` }} data-orientation={orientation}>
        <canvas ref={canvas} className="pitch-canvas" tabIndex={researchOpen ? -1 : 0}
          role="application" aria-roledescription="football pitch"
          aria-label="Illustrative passing animation. Click the grass or drag the ball to play it. With the keyboard, use the arrow keys to aim, Enter to play the ball and R to reset. Field components open research."
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; }} onPointerLeave={onLeave}
          onKeyDown={onKey} onFocus={() => { aim.current = { x: state.current.ball.u * L, y: state.current.ball.v * W }; paint(); }}
          onBlur={() => { aim.current = null; paint(); }} />
        <svg className="pitch-layer" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden={false} role="group" aria-label="Research destinations on the pitch">
          <g transform={T}>
            {DESTINATIONS.map((d) => (
              <g key={d.id} className={`dest dest-${d.id} ${hot?.id === d.id ? "is-hot" : ""} ${activeDest === d.id ? "is-active" : ""}`}
                data-dest={d.id} tabIndex={researchOpen ? -1 : 0} role="button"
                aria-label={`${d.component}: ${d.title}. ${d.detail}.`}
                onClick={(e) => activate(d, e.currentTarget)} onKeyDown={destKey(d)}
                onPointerEnter={() => enter(d)} onPointerLeave={() => leave(d)} onFocus={() => enter(d)} onBlur={() => leave(d)}>
                <DestShape d={d} />
              </g>
            ))}
          </g>
        </svg>
        <div className="paint-layer" aria-hidden="true">
          {DESTINATIONS.map((d) => {
            const p = (orientation === "portrait" ? PAINT_PORTRAIT : PAINT)[d.id];
            const f = toFraction(p.at, orientation);
            const vertical = orientation === "landscape" && (d.id === "goal-left" || d.id === "goal-right");
            return <span key={d.id} className={`paint paint-${p.place} ${vertical ? "vertical" : ""} ${hot?.id === d.id || activeDest === d.id ? "is-hot" : ""}`}
              style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%` }}>
              {p.num && <b>{p.num}</b>}{p.text}
            </span>;
          })}
          <span className="paint paint-c touchline" style={{ left: "50%", top: `${toFraction({ x: L / 2, y: W + 3.1 }, orientation).y * 100}%`, ...(orientation === "portrait" ? { display: "none" } : {}) }}>
            Find the edge. Beat the market.
          </span>
        </div>
        {hot && card && (
          <div className={`pitch-card ${card.x > 0.6 ? "to-left" : card.x < 0.4 ? "to-right" : "centred"} ${card.y > 0.55 ? "above" : "below"}`}
            style={{ left: `${card.x * 100}%`, top: `${card.y * 100}%` }} aria-hidden="true">
            <span className="pitch-card-k">{hot.component}</span>
            <strong>{hot.title}</strong>
            <span className="pitch-card-d">{hot.detail}</span>
            <span className="pitch-card-cta">Click or press Enter to open ↗</span>
          </div>
        )}
      </div>
      <div className="pitch-foot">
        <span className="pitch-foot-instruction">Find the edge. Beat the market.</span>
        <div className="pitch-controls" role="group" aria-label="Pitch controls">
          <button type="button" className="ctl" aria-pressed={!motion} onClick={() => setMotion((m) => !m)}>
            <span aria-hidden="true">{motion ? "❚❚" : "▶"}</span>{motion ? "Pause play" : "Resume play"}
          </button>
          <button type="button" className="ctl" onClick={doReset}><span aria-hidden="true">↺</span>Reset ball</button>
        </div>
      </div>
    </div>
  );
}

function DestShape({ d }: { d: Destination }) {
  if (d.id.startsWith("flag-")) {
    const c = d.hit.kind === "circle" ? d.hit : { cx: 0, cy: 0 };
    const sx = c.cx === 0 ? -1 : 1, sy = c.cy === 0 ? -1 : 1;
    return <>
      <circle className="dest-hit" cx={c.cx} cy={c.cy} r={4.6} pointerEvents="all" />
      <circle className="dest-glow ring" cx={c.cx} cy={c.cy} r={2.2} />
      <g className="flag" style={{ transformOrigin: `${c.cx}px ${c.cy}px` }}>
        <line className="flag-pole" x1={c.cx} y1={c.cy} x2={c.cx + sx * 2.3} y2={c.cy + sy * 2.3} />
        <path className="flag-cloth" d={`M${c.cx + sx * 2.3} ${c.cy + sy * 2.3}l${sx * 2.5} ${-sy * .3}l${-sx * 1.2} ${sy * 1.6}z`} />
        <circle className="flag-base" cx={c.cx} cy={c.cy} r={.34} />
      </g>
    </>;
  }
  const s = d.hit;
  if (d.id === "halfway") return <>
    <rect className="dest-hit" x={L / 2 - 1.6} y={-2} width={3.2} height={W / 2 - CIRCLE_R + 2} pointerEvents="all" />
    <rect className="dest-hit" x={L / 2 - 1.6} y={W / 2 + CIRCLE_R} width={3.2} height={W / 2 - CIRCLE_R} pointerEvents="all" />
    <path className="dest-glow" d={`M${L / 2} 0V${W / 2 - CIRCLE_R}M${L / 2} ${W / 2 + CIRCLE_R}V${W}`} />
  </>;
  if (d.id === "centre") return <>
    <circle className="dest-hit" cx={L / 2} cy={W / 2} r={CIRCLE_R} pointerEvents="all" />
    <circle className="dest-glow fill" cx={L / 2} cy={W / 2} r={CIRCLE_R} />
  </>;
  if (d.id === "goal-left" || d.id === "goal-right") {
    const x = d.id === "goal-left" ? -GOAL_DEPTH : L;
    return <>
      {s.kind === "rect" && <rect className="dest-hit" x={s.x} y={s.y} width={s.w} height={s.h} pointerEvents="all" />}
      <rect className="dest-glow fill" x={x} y={(W - GOAL_WIDTH) / 2} width={GOAL_DEPTH} height={GOAL_WIDTH} />
    </>;
  }
  const left = d.id === "box-left";
  const py = (W - PEN_WIDTH) / 2;
  return <>
    {s.kind === "rect" && <rect className="dest-hit" x={s.x} y={s.y} width={s.w} height={s.h} pointerEvents="all" />}
    <path className="dest-glow fill" d={left ? `M0 ${py}H${PEN_DEPTH}V${py + PEN_WIDTH}H0Z` : `M${L} ${py}H${L - PEN_DEPTH}V${py + PEN_WIDTH}H${L}Z`} />
  </>;
}
