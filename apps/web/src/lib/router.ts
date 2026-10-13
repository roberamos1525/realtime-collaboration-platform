import { useSyncExternalStore } from "react";

/**
 * Tiny History-API router: path matching with `:params`, navigation and a
 * hook that re-renders on location changes.
 */

const NAV_EVENT = "rcp:navigate";

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i] as string;
    const seg = s[i] as string;
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(seg);
      } catch {
        return null;
      }
    } else if (part !== seg) {
      return null;
    }
  }
  return params;
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAV_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

const snapshot = (): string => `${window.location.pathname}${window.location.search}`;

/** Current path + query string; re-renders on navigation. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot, () => "/");
}

export function queryParam(location: string, name: string): string | null {
  const q = location.indexOf("?");
  if (q < 0) return null;
  return new URLSearchParams(location.slice(q + 1)).get(name);
}

export interface RouteDef<T extends string> {
  readonly name: T;
  readonly pattern: string;
}

/** Returns the first route matching `path`, with its params. */
export function resolveRoute<T extends string>(routes: readonly RouteDef<T>[], path: string): { name: T; params: Record<string, string> } | null {
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (params) return { name: route.name, params };
  }
  return null;
}
