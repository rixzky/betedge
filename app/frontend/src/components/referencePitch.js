// Visual canvas adapted from the user-supplied Omma reference. No analytical data or decision logic.
// Hero canvas: a top-down pitch with a passing move you can interfere with
const FH = [[.05,.5],[.22,.14],[.2,.38],[.2,.62],[.22,.86],[.42,.28],[.38,.5],[.42,.72],[.64,.16],[.7,.5],[.64,.84]];
const FA = [[.05,.5],[.22,.14],[.2,.38],[.2,.62],[.22,.86],[.4,.15],[.38,.38],[.38,.62],[.4,.85],[.6,.38],[.6,.62]];

export function initHeroPitch(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  let reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, px = 0, py = 0, pw = 0, ph = 0, S = 1;
  const ptr = { x: 0, y: 0, on: false };
  const mk = (team, u, v, gk) => ({ team, gk, bu: u, bv: v, u, v, ph: Math.random() * 6.28 });
  const players = [];
  FH.forEach((p, i) => players.push(mk(0, p[0], p[1], i === 0)));
  FA.forEach((p, i) => players.push(mk(1, 1 - p[0], p[1], i === 0)));
  const started = performance.now();
  const ball = { u: .2, v: .5, mode: 'hold', holder: 2, t0: 0, dur: 1, fu: 0, fv: 0, tu: 0, tv: 0, toIdx: 0, until: started + 900, trail: [] };
  let ripple = null, last = started, raf = 0, visible = true, paused = false, destroyed = false, dragging = false;
  const abort = new AbortController();

  const X = (u) => px + u * pw;
  const Y = (v) => py + v * ph;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = Math.min(W, H) * 0.07;
    let w = W - m * 2, h = H - m * 2;
    const asp = 105 / 68;
    if (w / h > asp) w = h * asp; else h = w / asp;
    pw = w; ph = h; px = (W - w) / 2; py = (H - h) / 2; S = pw / 105;
    if (reduce) draw(started + 2400);
  }

  function decide(now) {
    const h = players[ball.holder];
    ball.t0 = now; ball.fu = ball.u; ball.fv = ball.v;
    if (h.u > 0.7 && Math.random() < 0.5) {
      ball.mode = 'shot'; ball.tu = 1.0; ball.tv = 0.5 + (Math.random() - 0.5) * 0.16; ball.dur = 520;
      return;
    }
    const w = []; let tot = 0;
    for (let i = 0; i < 11; i++) {
      if (i === ball.holder) continue;
      const c = players[i];
      const d = Math.hypot((c.u - h.u) * pw, (c.v - h.v) * ph) / pw;
      let wt = Math.exp(-d * 5) * (1 + Math.max(0, c.u - h.u) * 3.5);
      if (c.gk && h.u > 0.3) wt *= 0.05;
      w.push([i, wt]); tot += wt;
    }
    let r = Math.random() * tot, best = w[0][0];
    for (const [i, wt] of w) { r -= wt; if (r <= 0) { best = i; break; } }
    const t = players[best];
    ball.mode = 'pass'; ball.toIdx = best;
    ball.dur = 260 + Math.hypot((t.u - h.u) * pw, (t.v - h.v) * ph) * 1.1;
  }

  function nearestHome(u, v) {
    let bi = 1, bd = 9;
    for (let i = 1; i < 11; i++) {
      const d = Math.hypot(players[i].u - u, players[i].v - v);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  function update(now, dt) {
    const shift = (ball.u - 0.5) * 0.2;
    players.forEach((p) => {
      let tu = p.bu + (p.gk ? 0 : shift) + Math.sin(now * 0.0007 + p.ph) * 0.012;
      let tv = 0.5 + (p.bv - 0.5) * 0.94 + (ball.v - 0.5) * (p.gk ? 0.25 : 0.1) + Math.cos(now * 0.0009 + p.ph * 1.7) * 0.016;
      if (ptr.on && !p.gk) {
        const dx = ptr.x - X(p.u), dy = ptr.y - Y(p.v), d = Math.hypot(dx, dy), R = 150;
        if (d < R) { const f = Math.pow(1 - d / R, 2) * 0.6; tu += (dx / pw) * f; tv += (dy / ph) * f; }
      }
      const k = 1 - Math.exp(-dt * 0.006);
      p.u += (tu - p.u) * k; p.v += (tv - p.v) * k;
    });
    if (dragging || ball.mode === 'manual') return;
    const h = players[ball.holder];
    const k = Math.min(1, (now - ball.t0) / ball.dur);
    const e = 1 - (1 - k) * (1 - k);
    if (ball.mode === 'hold') {
      ball.u = h.u + 0.012; ball.v = h.v + 0.01;
      if (now > ball.until) decide(now);
    } else if (ball.mode === 'pass') {
      const t = players[ball.toIdx];
      ball.u = ball.fu + (t.u - ball.fu) * e; ball.v = ball.fv + (t.v - ball.fv) * e;
      if (k >= 1) { ball.holder = ball.toIdx; ball.mode = 'hold'; ball.until = now + 260 + Math.random() * 320; }
    } else if (ball.mode === 'shot') {
      ball.u = ball.fu + (ball.tu - ball.fu) * e; ball.v = ball.fv + (ball.tv - ball.fv) * e;
      if (k >= 1) { ripple = { u: ball.u, v: ball.v, t: now }; ball.mode = 'dead'; ball.until = now + 1100; }
    } else if (ball.mode === 'kick') {
      ball.u = ball.fu + (ball.tu - ball.fu) * e; ball.v = ball.fv + (ball.tv - ball.fv) * e;
      if (k >= 1) { ball.holder = nearestHome(ball.u, ball.v); ball.mode = 'hold'; ball.until = now + 300; }
    } else if (ball.mode === 'dead') {
      if (now > ball.until) { ball.holder = 2; ball.mode = 'hold'; ball.until = now + 400; ball.trail.length = 0; }
    }
    ball.trail.push({ u: ball.u, v: ball.v, t: now });
    while (ball.trail.length && now - ball.trail[0].t > 520) ball.trail.shift();
  }

  function marks() {
    const m = (x, y) => [px + x * S, py + y * S];
    ctx.lineWidth = Math.max(1.4, S * 0.28);
    ctx.strokeStyle = 'rgba(249,250,242,.82)';
    ctx.strokeRect(px, py, pw, ph);
    const line = (a, b, c, d) => { ctx.beginPath(); ctx.moveTo(...m(a, b)); ctx.lineTo(...m(c, d)); ctx.stroke(); };
    const rect = (x, y, w, h) => ctx.strokeRect(...m(x, y), w * S, h * S);
    const arc = (x, y, r, a, b) => { ctx.beginPath(); ctx.arc(...m(x, y), r * S, a, b); ctx.stroke(); };
    const spot = (x, y) => { ctx.beginPath(); ctx.arc(...m(x, y), Math.max(2, S * 0.3), 0, 6.283); ctx.fillStyle = 'rgba(249,250,242,.9)'; ctx.fill(); };
    line(52.5, 0, 52.5, 68);
    arc(52.5, 34, 9.15, 0, 6.283); spot(52.5, 34);
    rect(0, 13.84, 16.5, 40.32); rect(88.5, 13.84, 16.5, 40.32);
    rect(0, 24.84, 5.5, 18.32); rect(99.5, 24.84, 5.5, 18.32);
    spot(11, 34); spot(94, 34);
    arc(11, 34, 9.15, -0.9276, 0.9276); arc(94, 34, 9.15, Math.PI - 0.9276, Math.PI + 0.9276);
    arc(0, 0, 1.2, 0, Math.PI / 2); arc(105, 0, 1.2, Math.PI / 2, Math.PI);
    arc(105, 68, 1.2, Math.PI, Math.PI * 1.5); arc(0, 68, 1.2, Math.PI * 1.5, Math.PI * 2);
    rect(-2, 30.34, 2, 7.32); rect(105, 30.34, 2, 7.32);
  }

  function draw(now) {
    const el = Math.max(0, now - started);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#084535'; ctx.fillRect(0, 0, W, H);
    const n = 14;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? '#0c654f' : '#106b53';
      ctx.fillRect(px + (i * pw) / n, py, pw / n + 0.6, ph);
    }
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(20,32,16,0)'); vg.addColorStop(1, 'rgba(20,32,16,.4)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    const t = reduce ? 1 : Math.min(1, el / 800);
    const rr = (1 - Math.pow(1 - t, 3)) * Math.hypot(W, H) * 0.55;
    ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, rr, 0, 6.283); ctx.clip(); marks(); ctx.restore();

    // passing network
    ctx.lineWidth = 1;
    for (let i = 0; i < 11; i++) for (let j = i + 1; j < 11; j++) {
      const a = players[i], b = players[j];
      const d = Math.hypot((a.u - b.u) * pw, (a.v - b.v) * ph) / pw;
      if (d < 0.26) {
        ctx.strokeStyle = `rgba(249,250,242,${(1 - d / 0.26) * 0.18})`;
        ctx.beginPath(); ctx.moveTo(X(a.u), Y(a.v)); ctx.lineTo(X(b.u), Y(b.v)); ctx.stroke();
      }
    }
    if (ball.mode === 'pass') {
      const tp = players[ball.toIdx];
      ctx.strokeStyle = 'rgba(249,250,242,.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(ball.fu), Y(ball.fv)); ctx.lineTo(X(tp.u), Y(tp.v)); ctx.stroke();
    }
    if (ptr.on) {
      const g = ctx.createRadialGradient(ptr.x, ptr.y, 0, ptr.x, ptr.y, 150);
      g.addColorStop(0, 'rgba(249,250,242,.2)'); g.addColorStop(1, 'rgba(249,250,242,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ptr.x, ptr.y, 150, 0, 6.283); ctx.fill();
      ctx.save(); ctx.setLineDash([6, 8]); ctx.lineDashOffset = -now * 0.02;
      ctx.strokeStyle = 'rgba(249,250,242,.45)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(ptr.x, ptr.y, 70, 0, 6.283); ctx.stroke(); ctx.restore();
    }

    const r = Math.max(5, S * 0.62);
    players.forEach((p, i) => {
      const x = X(p.u), y = Y(p.v);
      ctx.fillStyle = 'rgba(15,25,12,.28)';
      ctx.beginPath(); ctx.ellipse(x + 2, y + r * 0.7, r, r * 0.5, 0, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283);
      ctx.fillStyle = p.team === 0 ? (p.gk ? '#D9E1C8' : '#F9FAF2') : '#202E1C';
      ctx.fill();
      ctx.lineWidth = 1.6; ctx.strokeStyle = p.team === 0 ? '#202E1C' : '#F9FAF2'; ctx.stroke();
      if (p.gk) { ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, 6.283); ctx.fillStyle = p.team === 0 ? '#202E1C' : '#F9FAF2'; ctx.fill(); }
      if (ball.mode === 'hold' && i === ball.holder) {
        ctx.strokeStyle = 'rgba(249,250,242,.85)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(x, y, r + 6 + Math.sin(now * 0.008) * 2, 0, 6.283); ctx.stroke();
      }
    });

    // ball trail
    for (let i = 1; i < ball.trail.length; i++) {
      const a = ball.trail[i - 1], b = ball.trail[i];
      const age = 1 - (now - b.t) / 520;
      ctx.strokeStyle = `rgba(249,250,242,${Math.max(0, age) * 0.8})`;
      ctx.lineWidth = 1 + age * 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X(a.u), Y(a.v)); ctx.lineTo(X(b.u), Y(b.v)); ctx.stroke();
    }
    const bx = X(ball.u), by = Y(ball.v), br = r * 0.72;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.283); ctx.fillStyle = '#F9FAF2'; ctx.fill();
    ctx.lineWidth = 1.3; ctx.strokeStyle = '#202E1C'; ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.283 - 1.57 + now * 0.002; const x = bx + Math.cos(a) * br * 0.45, y = by + Math.sin(a) * br * 0.45; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.fillStyle = '#202E1C'; ctx.fill();

    if (ripple) {
      const k = (now - ripple.t) / 1000;
      if (k < 1) {
        ctx.strokeStyle = `rgba(249,250,242,${1 - k})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(ripple.u), Y(ripple.v), 10 + k * 70, 0, 6.283); ctx.stroke();
      } else ripple = null;
    }
  }

  function frame(t) {
    raf = 0;
    if (!visible || paused || destroyed || document.hidden || reduce) return;
    const dt = Math.max(0, Math.min(50, t - last)); last = t;
    update(t, dt); draw(t);
    raf = requestAnimationFrame(frame);
  }

  const point = (e) => {const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
  const kick = (u,v,duration=360) => {const now=performance.now();ball.mode='kick';ball.t0=now;ball.dur=duration;ball.fu=ball.u;ball.fv=ball.v;ball.tu=u;ball.tv=v;if(reduce){ball.u=u;ball.v=v;ball.mode='manual';draw(now);} };
  const schedule = () => {if(!destroyed&&!paused&&visible&&!document.hidden&&!reduce&&!raf){last=performance.now();raf=requestAnimationFrame(frame);}};
  canvas.addEventListener('pointermove', e => {
    const q=point(e);ptr.x=q.x;ptr.y=q.y;ptr.on=true;
    if(dragging){ball.u=Math.max(0,Math.min(1,(q.x-px)/pw));ball.v=Math.max(0,Math.min(1,(q.y-py)/ph));ball.mode='manual';ball.trail.length=0;draw(performance.now());}
    else if(reduce||paused)draw(performance.now());
  }, {signal:abort.signal});
  canvas.addEventListener('pointerleave',()=>{ptr.on=false;if(reduce||paused)draw(performance.now());},{signal:abort.signal});
  let suppressClick=false;
  canvas.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;const q=point(e);
    if(Math.hypot(q.x-X(ball.u),q.y-Y(ball.v))<Math.max(22,S*2.5)){
      dragging=true;suppressClick=true;ball.mode='manual';canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';
    }
  },{signal:abort.signal});
  canvas.addEventListener('pointerup',e=>{
    if(!dragging)return;dragging=false;canvas.style.cursor='crosshair';
    if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    options.onDrop?.({x:X(ball.u)/W*100,y:Y(ball.v)/H*100});
    ball.holder=nearestHome(ball.u,ball.v);ball.mode='hold';ball.until=performance.now()+500;schedule();
  },{signal:abort.signal});
  canvas.addEventListener('pointercancel',()=>{dragging=false;canvas.style.cursor='crosshair';ball.holder=nearestHome(ball.u,ball.v);ball.mode='hold';ball.until=performance.now()+500;},{signal:abort.signal});
  canvas.addEventListener('click',e=>{
    if(suppressClick){suppressClick=false;return;}const q=point(e);
    kick(Math.max(0,Math.min(1,(q.x-px)/pw)),Math.max(0,Math.min(1,(q.y-py)/ph)));schedule();
  },{signal:abort.signal});
  const ro=new ResizeObserver(resize);ro.observe(canvas);resize();
  const io=new IntersectionObserver(es=>{visible=es[0].isIntersecting;if(!visible&&raf){cancelAnimationFrame(raf);raf=0;}schedule();});io.observe(canvas);
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&raf){cancelAnimationFrame(raf);raf=0;}else schedule();},{signal:abort.signal});
  schedule();
  return {
    setPaused(value){paused=value;if(paused&&raf){cancelAnimationFrame(raf);raf=0;}else schedule();},
    setMotion(value){reduce=!value||matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduce&&raf){cancelAnimationFrame(raf);raf=0;}draw(performance.now());schedule();},
    kickToPercent(x,y){kick(Math.max(0,Math.min(1,(x/100*W-px)/pw)),Math.max(0,Math.min(1,(y/100*H-py)/ph)),220);schedule();},
    reset(){ball.trail.length=0;kick(.5,.5,220);schedule();},
    destroy(){destroyed=true;abort.abort();ro.disconnect();io.disconnect();cancelAnimationFrame(raf);}
  };
}
