import { useEffect, useRef, useState } from "react";
import type { Screen } from "../route";
import { initHeroPitch, type PitchController } from "./referencePitch";

const TOOLS: { id: Screen; label: string; short: string; hint: string; corner: string; number: string }[] = [
  { id: "map", label: "Efficiency map", short: "The market", hint: "Explore league × season", corner: "tl", number: "01" },
  { id: "replay", label: "Match replay", short: "Match replay", hint: "Follow a decision", corner: "tr", number: "02" },
  { id: "evidence", label: "Evidence", short: "The evidence", hint: "Compare the results", corner: "br", number: "03" },
  { id: "audit", label: "Data audit", short: "Data quality", hint: "Inspect the source", corner: "bl", number: "04" },
];

export function PitchNav({ screen, onGo }: { screen: Screen; onGo: (screen: Screen) => void }) {
  return <nav className="research-nav" aria-label="Research tools">
    <button type="button" aria-current={screen === "home" ? "page" : undefined} onClick={() => onGo("home")}>The pitch</button>
    {TOOLS.map((tool) => <button type="button" key={tool.id} aria-current={screen === tool.id ? "page" : undefined}
      onClick={() => onGo(tool.id)}>{tool.label}</button>)}
  </nav>;
}

// Flat vector pitch: semantic buttons, no perspective or navigation delay.
export function ResearchPitch({ onGo, active=true }: { onGo: (screen: Screen) => void; active?:boolean }) {
  const field = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<PitchController|null>(null);
  const drop = useRef<(point:{x:number;y:number})=>void>(()=>{});
  const [motion,setMotion]=useState(()=>!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{if(!canvas.current)return;controller.current=initHeroPitch(canvas.current,{onDrop:point=>drop.current(point)});return()=>{controller.current?.destroy();controller.current=null;};},[]);
  useEffect(()=>controller.current?.setPaused(!active),[active]);
  useEffect(()=>controller.current?.setMotion(motion),[motion]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [message, setMessage] = useState("Select a flag, goal or pitch marking. You can also drag the ball.");
  useEffect(() => () => clearTimeout(timer.current), []);
  const targets = [
    {id:"map",x:6,y:9,route:"map",text:"Efficiency map · explore market calibration by league and season."},
    {id:"replay",x:94,y:9,route:"replay",text:"Match replay · inspect the forecast, offered price and decision."},
    {id:"evidence",x:94,y:91,route:"evidence",text:"Evidence · compare models, policies and uncertainty."},
    {id:"audit",x:6,y:91,route:"audit",text:"Data audit · inspect source quality and exclusions."},
    {id:"left-goal",x:4.5,y:50,route:"replay",text:"Price checks · open the replay and inspect bookmaker prices."},
    {id:"right-goal",x:95.5,y:50,route:"evidence",text:"Results · inspect measured forecast and policy performance."},
    {id:"left-area",x:15,y:50,route:"audit",text:"Defend the inputs · inspect invalid quotes, timestamps and exclusions."},
    {id:"right-area",x:85,y:50,route:"replay",text:"Challenge the decision · inspect stress assumptions and no-bet reasons."},
    {id:"centre",x:50,y:50,route:"replay",text:"Kick off · open a match replay, then reveal its outcome deliberately."},
    {id:"halfway",x:50,y:78,route:"evidence",text:"Compare both sides · review model accuracy and calibration."},
  ] as const;
  const preview = (id:string|null) => {const t=targets.find(t=>t.id===id);setMessage(t?.text ?? "Select a flag, goal or pitch marking. You can also drag the ball.");};
  const openTarget = (id:string) => {
    const t=targets.find(t=>t.id===id); if(!t)return;
    clearTimeout(timer.current);controller.current?.kickToPercent(t.x,t.y);preview(id);
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current=setTimeout(()=>onGo(t.route),reduced?0:220);
  };
  drop.current=point=>{const near=[...targets].sort((a,b)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(b.x-point.x,b.y-point.y))[0];if(Math.hypot(near.x-point.x,near.y-point.y)<13)openTarget(near.id);};
  const [hover, setHover] = useState<Screen | null>(null);
  return <div className="research-pitch-wrap">
    <div className="pitch-topline"><span>YOUR RESEARCH PITCH</span><span>SELECT A COMPONENT ↗</span></div>
    <div ref={field} className={`research-pitch interactive-field  ${hover ? `pitch-focus-${hover}` : ""}`}>
      <canvas ref={canvas} className="reference-pitch-canvas" aria-label="Illustrative football passing animation. Click the grass to pass, or drag the moving ball. The labelled controls open research tools." />
      {targets.map(t=><button type="button" key={t.id} className={`pitch-hit hit-${t.id} ${hover===t.route?"is-target":""}`} style={{left:`${t.x}%`,top:`${t.y}%`}}
        aria-label={t.text} title={t.text} onMouseEnter={()=>{setHover(t.route);preview(t.id);}} onMouseLeave={()=>{setHover(null);preview(null);}}
        onFocus={()=>{setHover(t.route);preview(t.id);}} onBlur={()=>{setHover(null);preview(null);}} onClick={()=>openTarget(t.id)}>
        <span className="hit-marker"/><span className="hit-label">{t.id==="left-goal"?"PRICES":t.id==="right-goal"?"RESULTS":t.id==="left-area"?"DATA CHECKS":t.id==="right-area"?"STRESS TEST":t.id==="centre"?"REPLAY":t.id==="halfway"?"COMPARE MODELS":""}</span>
      </button>)}
      <div className="pitch-centre-word" aria-hidden="true"><span>THE GAME.</span><span>THE PRICE.</span><em>THE PROOF.</em></div>
      {TOOLS.map((tool) => <button type="button" key={tool.id} className={`pitch-tool ${tool.corner}`}
        onMouseEnter={() => {setHover(tool.id);preview(tool.id);}} onMouseLeave={() => {setHover(null);preview(null);}}
        onFocus={() => {setHover(tool.id);preview(tool.id);}} onBlur={() => {setHover(null);preview(null);}} onClick={() => openTarget(tool.id)}>
        <span className="pitch-tool-top"><span>{tool.number}</span><span aria-hidden="true">↗</span></span>
        <strong>{tool.short}</strong><span className="pitch-tool-hint">{tool.hint}</span>
      </button>)}

    </div>
    <div className="pitch-preview" role="status" aria-live="polite"><span className="preview-indicator"/><span>{message}</span></div>
    <div className="pitch-bottomline"><span>ILLUSTRATIVE ANIMATION · RESEARCH VIA LABELLED CONTROLS</span><button type="button" className="reset-pitch-ball" aria-pressed={motion} onClick={()=>setMotion(!motion)}>{motion?"Pause play":"Resume play"}</button><button type="button" className="reset-pitch-ball" onClick={()=>{clearTimeout(timer.current);controller.current?.reset();setHover(null);preview(null);}}>Reset ball ↺</button></div>
  </div>;
}
