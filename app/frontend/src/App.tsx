import { lazy, Suspense, useEffect, useRef } from "react";
import type { Meta } from "../../../contract/api_types";
import { api, useApi } from "./api";
import { PitchNav } from "./components/PitchNav";
import { Ball, ErrorBox, Loading } from "./components/ui";
import { PROJECT_SUBTITLE, PROJECT_TITLE, USE_MOCKS } from "./config";
import { go, useRoute } from "./route";
import { AuditScreen } from "./screens/Audit";
import { EfficiencyMapScreen } from "./screens/EfficiencyMap";
import { ReplayScreen } from "./screens/Replay";
import { HomeScreen } from "./screens/Home";

// The chart library loads only when Evidence opens, keeping the pitch home light.
const EvidenceScreen = lazy(() => import("./screens/Evidence").then((module) => ({ default: module.EvidenceScreen })));

function Badges({ meta }: { meta: Meta }) {
  return (
    <div className="badges">
      {USE_MOCKS && <span className="badge warn">MOCK MODE · golden API examples</span>}
      <span className={`badge ${meta.storage_backend === "tiger" ? "on" : ""}`} title="What is actually active, from /api/meta">
        <span className="dot" />{meta.storage_backend === "tiger" ? "Tiger Data · active" : "Storage · local files"}
      </span>
      <span className={`badge ${meta.gemini_enabled ? "on" : ""}`}>
        <span className="dot" />{meta.gemini_enabled ? "Gemini · active" : "Gemini · not configured"}
      </span>
      <span className="badge mono">contract {meta.contract_version}</span>
      <span className="badge mono" title="frozen_config.json hash">{meta.frozen_config_hash ? `config ${meta.frozen_config_hash}` : "config not frozen"}</span>
      <span className={`badge ${meta.holdout_locked ? "on" : ""}`}><span className="dot" />{meta.holdout_locked ? "Holdout locked" : "Holdout hidden"}</span>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const overlay = useRef<HTMLDialogElement>(null);
  const meta = useApi<Meta>(() => api.meta(), []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    document.title = `${route.screen === "home" ? "The pitch" : route.screen === "map" ? "Efficiency map" : route.screen === "replay" ? "Match replay" : route.screen === "evidence" ? "Evidence" : "Data audit"} | ${PROJECT_TITLE}`;
  }, [route.screen]);
  useEffect(() => {
    const dialog=overlay.current;
    if(!dialog)return;
    if(route.screen!=="home"&&!dialog.open)dialog.showModal();
    if(route.screen==="home"&&dialog.open)dialog.close();
  }, [route.screen, meta.data]);
  return (
    <div className="shell is-home">
      <a href="#research-main" className="skip-link">Skip to workspace</a>
      <header className="topbar">
        <div className="brand">
          <div className="brand-title"><Ball size={22} />{PROJECT_TITLE}</div>
          <div className="brand-sub">{PROJECT_SUBTITLE}</div>
        </div>
        <PitchNav screen={route.screen} onGo={(s) => go(s)} />
        {meta.data ? <details className="workspace-status"><summary><span className="status-dot" />Workspace status</summary><Badges meta={meta.data} /></details> : <div />}
      </header>
      {meta.data?.dataset_mode === "SYNTHETIC" && (
        <div className="synthetic" role="note">
          <b>Synthetic demonstration</b>
          <span>Invented teams and prices for building and testing. Nothing on screen is a real result.</span>
        </div>
      )}
      {meta.error && <ErrorBox error={`Could not reach the API: ${meta.error}. Start it with "uvicorn app.backend.main:app --port 8000" (USE_GOLDEN=1 for golden files), or run the UI with VITE_USE_MOCKS=1.`} />}
      {!meta.data && !meta.error && <Loading what="metadata" />}
      {meta.data && (
        <main id="research-main" tabIndex={-1}>
          <HomeScreen meta={meta.data} active={route.screen === "home"} />
          <dialog ref={overlay} className="pitch-research-overlay" aria-label="Research workspace over the pitch"
            onCancel={(event)=>{event.preventDefault();go("home");}}>
            <div className="overlay-topbar"><PitchNav screen={route.screen} onGo={screen=>go(screen)}/><button type="button" className="close-pitch-overlay" onClick={()=>go("home")} aria-label="Close research and return to pitch">Back to pitch <span aria-hidden="true">×</span></button></div>
            <div className="overlay-content"><Suspense fallback={<Loading what="research view" />}>
          {route.screen === "map" && <EfficiencyMapScreen meta={meta.data} />}
          {route.screen === "replay" && <ReplayScreen key="replay" meta={meta.data} params={route.params} />}
          {route.screen === "evidence" && <EvidenceScreen meta={meta.data} params={route.params} />}
          {route.screen === "audit" && <AuditScreen />}
          </Suspense></div></dialog>
        </main>
      )}
      <footer className="footer">
        <span>Paper trading research. No real money, accounts or in-play betting.</span>
        <span>Every number comes from the artifact files via the API; missing values show n/a.</span>
        <span>Outcome order H · D · A.</span>
      </footer>
    </div>
  );
}
