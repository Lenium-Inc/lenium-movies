/**
 * Viewer preferences: theme palette, default playback quality, preview
 * autoplay, subtitle default, and the watch-history master switch. Persisted
 * to localStorage and broadcast to subscribers via a custom DOM event so the
 * profile page and player stay in sync.
 */
import type { StreamQuality } from "./api";

export type ThemeMode = "void" | "charcoal" | "high";
export type QualityPref = "auto" | StreamQuality;
export type SubtitlePref = "auto" | "on" | "off";

export interface Settings {
  theme: ThemeMode;
  quality: QualityPref;
  autoplayPreviews: boolean;
  subtitles: SubtitlePref;
  historyEnabled: boolean;
}

const KEY = "freestream-prefs-v1";

const DEFAULTS: Settings = {
  theme: "void",
  quality: "auto",
  autoplayPreviews: true,
  subtitles: "auto",
  historyEnabled: true,
};

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("freestream:prefs"));
  } catch {
    /* storage unavailable — preferences degrade silently */
  }
  applyTheme(next.theme);
  return next;
}

export function historyEnabled(): boolean {
  return getSettings().historyEnabled;
}

export function subscribeSettings(listener: () => void): () => void {
  window.addEventListener("freestream:prefs", listener);
  return () => window.removeEventListener("freestream:prefs", listener);
}

/** Tag the root element with the active palette so CSS switches the shell. */
export function applyTheme(theme = getSettings().theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}
