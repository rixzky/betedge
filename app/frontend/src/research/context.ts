import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import type { ReplayPolicy } from "../types";

/** What the judge is currently looking at, shown in the research context bar on every tab. */
export interface ResearchContext {
  fixture?: string; // "Home v Away"
  matchId?: string;
  league?: string;
  season?: string;
  model?: string;
  modelVersion?: string;
  policy: ReplayPolicy;
}

export const ResearchCtx = createContext<{
  ctx: ResearchContext;
  setCtx: (c: ResearchContext) => void;
  scroller: RefObject<HTMLDivElement> | null;
}>({ ctx: { policy: "controlled" }, setCtx: () => undefined, scroller: null });

export const useResearch = () => useContext(ResearchCtx);

/**
 * Scroll the research workspace to `#sec-<section>` once it exists (data may still be loading),
 * and move keyboard focus there so screen-reader and keyboard users land in the same place.
 */
export function useSectionScroll(section: string | null | undefined, ready: unknown) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!section || done.current === section) return;
    let tries = 0;
    let id = 0;
    const attempt = () => {
      const el = document.getElementById(`sec-${section}`);
      if (el) {
        done.current = section;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
        el.focus({ preventScroll: true });
        return;
      }
      if (++tries < 60) id = window.requestAnimationFrame(attempt);
    };
    id = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(id);
  }, [section, ready]);
  useEffect(() => { if (!section) done.current = null; }, [section]);
}
