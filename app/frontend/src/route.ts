import { useEffect, useState } from "react";

export type Screen = "home" | "bets" | "map" | "replay" | "evidence" | "audit";
const SCREENS: Screen[] = ["home", "bets", "map", "replay", "evidence", "audit"];

export interface Route { screen: Screen; params: URLSearchParams }

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const screen = (SCREENS as string[]).includes(path) ? (path as Screen) : "home";
  return { screen, params: new URLSearchParams(query ?? "") };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(screen: Screen, params?: Record<string, string | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) p.set(k, v);
  const q = p.toString();
  window.location.hash = `#/${screen}${q ? `?${q}` : ""}`;
}

// Update query params of the current screen without adding history noise.
export function setParams(screen: Screen, params: Record<string, string | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const q = p.toString();
  const next = `#/${screen}${q ? `?${q}` : ""}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
}
