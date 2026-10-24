import { useEffect, useRef, useState } from "react";
import type { Meta } from "../../../contract/api_types";
import { api, useApi } from "./api";
import { Ball, ErrorBox } from "./components/ui";
import { PROJECT_SUBTITLE, PROJECT_TITLE, USE_MOCKS } from "./config";
import type { Destination, DestId } from "./pitch/geometry";
import { ResearchCtx, type ResearchContext } from "./research/context";
import { ResearchOverlay } from "./research/Overlay";
import { go, useRoute } from "./route";
import { HomeScreen } from "./screens/Home";
import type { Mode } from "./types";

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mode-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        aria-pressed={mode === "normal"}
        className={mode === "normal" ? "active" : ""}
        onClick={() => onChange("normal")}
      >
        Simple
      </button>
      <button
        type="button"
        aria-pressed={mode === "advanced"}
        className={mode === "advanced" ? "active" : ""}
        onClick={() => onChange("advanced")}
      >
        Expert
      </button>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const meta = useApi<Meta>(() => api.meta(), []);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [researchCtx, setResearchCtx] = useState<ResearchContext>({ policy: "controlled" });
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem("betedge-mode");
      return saved === "advanced" ? "advanced" : "normal";
    } catch {
      return "normal";
    }
  });

  const open = route.screen !== "home";

  useEffect(() => {
    try { localStorage.setItem("betedge-mode", mode); } catch { /* ignore */ }
  }, [mode]);

  useEffect(() => {
    const labels: Record<string, string> = {
      home: "The pitch",
      bets: "Best bets",
      replay: "Match replay",
      evidence: "Evidence",
      map: "Market trends",
      audit: "Data audit",
    };
    document.title = `${labels[route.screen] ?? route.screen} | ${PROJECT_TITLE}`;
  }, [route.screen]);

  const handleOpen = (dest: Destination, _opener: Element | null) => {
    go(dest.screen as Parameters<typeof go>[0], Object.keys(dest.params).length ? dest.params : undefined);
  };

  return (
    <ResearchCtx.Provider value={{ ctx: researchCtx, setCtx: setResearchCtx, scroller: scrollerRef }}>
      <a href="#research-main" className="skip-link">Skip to workspace</a>
      <div className={`app-bg${open ? " is-research" : ""}`}>
        <header className="topbar">
          <button
            type="button"
            className="brand brand-btn"
            onClick={() => go("home")}
            aria-label={`${PROJECT_TITLE} — return to pitch`}
          >
            <div className="brand-title"><Ball size={22} />{PROJECT_TITLE}</div>
            <div className="brand-sub">{PROJECT_SUBTITLE}</div>
          </button>
          <div className="topbar-center">
            {USE_MOCKS && <span className="badge warn">MOCK MODE · demo data</span>}
            {meta.data?.dataset_mode === "SYNTHETIC" && (
              <span className="synthetic-strip">SYNTHETIC DEMO DATA</span>
            )}
          </div>
          <ModeToggle mode={mode} onChange={setMode} />
        </header>

        {meta.error && !meta.data && (
          <div style={{ padding: "16px 24px" }}>
            <ErrorBox
              error={`Could not reach the API: ${meta.error}. Start it with "uvicorn app.backend.main:app --port 8000" (USE_GOLDEN=1 for demo data), or run the UI with VITE_USE_MOCKS=1.`}
            />
          </div>
        )}

        <HomeScreen
          meta={meta.data ?? null}
          researchOpen={open}
          activeDest={open ? (route.screen as DestId) : null}
          onOpen={handleOpen}
          mode={mode}
        />

        {open && meta.data && (
          <ResearchOverlay
            meta={meta.data}
            mode={mode}
            screen={route.screen as Exclude<typeof route.screen, "home">}
            params={route.params}
          />
        )}

        <footer className="footer">
          <span>Paper trading research only. No real money, accounts or in-play betting.</span>
          <span>Every number comes from the artifact files via the API; missing values show n/a.</span>
        </footer>
      </div>
    </ResearchCtx.Provider>
  );
}
