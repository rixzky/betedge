import { lazy, Suspense, useEffect, useRef } from "react";
import type { Meta } from "../../../../contract/api_types";
import { Loading } from "../components/ui";
import { go, type Screen } from "../route";
import type { Mode } from "../types";

const BetsScreen = lazy(() =>
  import("../screens/Bets").then((m) => ({ default: m.BetsScreen })),
);
const ReplayScreen = lazy(() =>
  import("../screens/Replay").then((m) => ({ default: m.ReplayScreen })),
);
const EvidenceScreen = lazy(() =>
  import("../screens/Evidence").then((m) => ({ default: m.EvidenceScreen })),
);
const EfficiencyMapScreen = lazy(() =>
  import("../screens/EfficiencyMap").then((m) => ({ default: m.EfficiencyMapScreen })),
);
const AuditScreen = lazy(() =>
  import("../screens/Audit").then((m) => ({ default: m.AuditScreen })),
);

interface Tab { id: Screen; label: string; advancedOnly: boolean }

const ALL_TABS: Tab[] = [
  { id: "bets",     label: "Best Bets",     advancedOnly: false },
  { id: "replay",   label: "Match Replay",  advancedOnly: false },
  { id: "evidence", label: "The Evidence",  advancedOnly: true  },
  { id: "map",      label: "Market Trends", advancedOnly: true  },
  { id: "audit",    label: "Data Audit",    advancedOnly: true  },
];

export function ResearchOverlay({
  meta, mode, screen, params,
}: {
  meta: Meta;
  mode: Mode;
  screen: Screen;
  params: URLSearchParams;
}) {
  const tabs = mode === "normal" ? ALL_TABS.filter((t) => !t.advancedOnly) : ALL_TABS;
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape → back to pitch
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") go("home"); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Move focus into the panel when it opens
  useEffect(() => {
    const el = panelRef.current?.querySelector<HTMLElement>("[autofocus], h1, h2, [tabindex='-1']");
    el?.focus({ preventScroll: true });
  }, [screen]);

  // If the current screen isn't available in normal mode, bounce to bets
  useEffect(() => {
    if (mode === "normal" && (screen === "map" || screen === "audit")) {
      go("bets");
    }
  }, [mode, screen]);

  return (
    <>
      <div className="research-scrim" onClick={() => go("home")} aria-hidden="true" />
      <div
        ref={panelRef}
        className="research-panel"
        role="region"
        aria-label="Research workspace"
        id="research-main"
      >
        <div className="research-head">
          <button
            type="button"
            className="btn ghost back-to-pitch"
            onClick={() => go("home")}
          >
            ← Back to pitch
          </button>
          <nav className="research-tabs" aria-label="Research sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`research-tab${screen === t.id ? " active" : ""}`}
                aria-current={screen === t.id ? "page" : undefined}
                onClick={() => go(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="research-scroll">
          <Suspense fallback={<div style={{ padding: 32 }}><Loading what="research view" /></div>}>
            {screen === "bets" && (
              <BetsScreen meta={meta} params={params} mode={mode} />
            )}
            {screen === "replay" && (
              <ReplayScreen meta={meta} params={params} mode={mode} />
            )}
            {screen === "evidence" && mode === "advanced" && (
              <EvidenceScreen meta={meta} params={params} mode={mode} />
            )}
            {screen === "map" && mode === "advanced" && (
              <EfficiencyMapScreen meta={meta} />
            )}
            {screen === "audit" && mode === "advanced" && (
              <AuditScreen />
            )}
          </Suspense>
        </div>
      </div>
    </>
  );
}
