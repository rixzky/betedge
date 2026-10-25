import { useEffect, useRef, useState } from "react";
import type { Meta } from "../../../contract/api_types";
import { api, useApi } from "./api";
import { ErrorBox } from "./components/ui";
import { PROJECT_TITLE } from "./config";
import type { Destination, DestId } from "./pitch/geometry";
import { ResearchCtx, type ResearchContext } from "./research/context";
import { ResearchOverlay } from "./research/Overlay";
import { go, useRoute } from "./route";
import { HomeScreen } from "./screens/Home";
import type { Mode } from "./types";

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className={`mode-toggle mode-${mode}`} role="group" aria-label="View mode">
      <span className="mode-toggle-indicator" aria-hidden="true" />
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
    document.body.dataset.mode = mode;
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
            <span className="brand-title">{PROJECT_TITLE}</span>
          </button>
          <ModeToggle mode={mode} onChange={setMode} />
        </header>

        {meta.error && !meta.data && (
          <div style={{ padding: "16px 24px" }}>
            <ErrorBox
              error={`Could not reach the API: ${meta.error}. Start it with "uvicorn app.backend.main:app --port 8000", or run the UI with VITE_USE_MOCKS=1.`}
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
      </div>
    </ResearchCtx.Provider>
  );
}
