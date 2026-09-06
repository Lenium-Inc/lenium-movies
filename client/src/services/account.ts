/**
 * Local profile & security store: email/display name, plan tier badge, a
 * demo-grade password vault (hashed), two-factor toggle, and a list of
 * signed-in devices. Everything lives on the viewer's machine — the auth
 * backend still owns the real session — so the feature is fully functional
 * as a client-side demo. Account state broadcasts via a DOM event.
 */
import { getSettings, historyEnabled } from "./settings";
import { savedListIds } from "./lists";
import { ratingLog } from "./ratings";
import {
  earnedAchievements,
  hoursWatched,
  playsToday,
} from "./stats";

export type PlanTier = "founder" | "dev";

export interface DeviceSession {
  id: string;
  device: string;
  browser: string;
  lastActive: string;
  current?: boolean;
}

export interface Account {
  email: string;
  displayName: string;
  plan: PlanTier;
  renewsAt: string;
  passwordHash: string | null;
  twoFactor: boolean;
  sessions: DeviceSession[];
  createdAt: string;
}

const KEY = "freestream-account-v1";
const SALT = "freestream::local-demo::";

function seed(): Account {
  const now = new Date();
  const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const named = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    email: "viewer@freestream.app",
    displayName: "Viewer",
    plan: "founder",
    renewsAt: later.toISOString(),
    passwordHash: null,
    twoFactor: false,
    createdAt: now.toISOString(),
    sessions: [
      {
        id: "this",
        device: "This browser",
        browser: detectBrowser(),
        lastActive: now.toISOString(),
        current: true,
      },
      { id: "tv", device: "Living-room TV", browser: "Browser", lastActive: named(2) },
      { id: "phone", device: "iPhone", browser: "Safari", lastActive: named(5) },
      { id: "laptop", device: "MacBook Pro", browser: "Safari", lastActive: named(9) },
    ],
  };
}

function detectBrowser(): string {
  if (typeof navigator === "undefined") return "Browser";
  const ua = navigator.userAgent;
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/safari|mobile\/.*safari/i.test(ua)) return "Safari";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/edg/i.test(ua)) return "Edge";
  return "Browser";
}

export function getAccount(): Account {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seed();
    return { ...seed(), ...(JSON.parse(raw) as Partial<Account>) };
  } catch {
    return seed();
  }
}

function saveAccount(account: Account): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(account));
    window.dispatchEvent(new CustomEvent("freestream:account"));
  } catch {
    /* storage unavailable */
  }
}

export function subscribeAccount(listener: () => void): () => void {
  window.addEventListener("freestream:account", listener);
  return () => window.removeEventListener("freestream:account", listener);
}

/** Only the current device removal is refused; any other session can leave. */
export function signOutSession(id: string): boolean {
  const account = getAccount();
  const target = account.sessions.find(s => s.id === id);
  if (!target || target.current) return false;
  account.sessions = account.sessions.filter(s => s.id !== id);
  saveAccount(account);
  return true;
}

export function setPlan(tier: PlanTier): void {
  const account = getAccount();
  account.plan = tier;
  account.renewsAt =
    tier === "dev"
      ? account.renewsAt
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  saveAccount(account);
}

async function hashPassword(password: string): Promise<string> {
  try {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(SALT + password)
    );
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let hash = 5381;
    const text = SALT + password;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 33) ^ text.charCodeAt(i);
    }
    return `fnv-${(hash >>> 0).toString(16)}`;
  }
}

export interface PasswordResult {
  ok: boolean;
  error?: string;
}

export async function updatePassword(
  current: string,
  next: string
): Promise<PasswordResult> {
  const account = getAccount();
  if (next.length < 8) {
    return { ok: false, error: "New password needs at least 8 characters." };
  }
  if (account.passwordHash) {
    const hash = await hashPassword(current);
    if (hash !== account.passwordHash) {
      return { ok: false, error: "Your current password is incorrect." };
    }
  }
  account.passwordHash = await hashPassword(next);
  saveAccount(account);
  return { ok: true };
}

/** 2FA requires a vault password so a forgotten password can't hide a breach. */
export async function toggleTwoFactor(enabled: boolean, password: string): Promise<PasswordResult> {
  const account = getAccount();
  if (enabled) {
    if (!account.passwordHash) {
      return { ok: false, error: "Set a password first, then enable two-factor." };
    }
    const hash = await hashPassword(password);
    if (hash !== account.passwordHash) {
      return { ok: false, error: "Your password is incorrect." };
    }
  }
  account.twoFactor = enabled;
  saveAccount(account);
  return { ok: true };
}

export function updateProfile(patch: Partial<Pick<Account, "email" | "displayName">>): void {
  const account = getAccount();
  if (patch.email !== undefined && patch.email.trim()) account.email = patch.email.trim();
  if (patch.displayName !== undefined && patch.displayName.trim()) {
    account.displayName = patch.displayName.trim();
  }
  saveAccount(account);
}

export interface ExportPayload {
  exportedAt: string;
  account: Omit<Account, "passwordHash">;
  settings: ReturnType<typeof getSettings>;
  hoursWatched: number;
  playsToday: number;
  achievements: string[];
  myList: ReturnType<typeof savedListIds>;
  ratings: ReturnType<typeof ratingLog>;
  historyEnabled: boolean;
}

/** A copy of the viewer's data, minus secrets — bound to a download trigger. */
export function exportUserData(): ExportPayload {
  return {
    exportedAt: new Date().toISOString(),
    account: (() => {
      const { passwordHash: _drop, ...rest } = getAccount();
      return rest;
    })(),
    settings: getSettings(),
    hoursWatched: hoursWatched(),
    playsToday: playsToday(),
    achievements: earnedAchievements().map(a => a.id),
    myList: savedListIds(),
    ratings: ratingLog(),
    historyEnabled: historyEnabled(),
  };
}

export function wipeLocalData(): void {
  const keys = [
    "freestream-stats-v1",
    "freestream-prefs-v1",
    "freestream-list-v1",
    "freestream-ratings-v1",
    "freestream-account-v1",
  ];
  keys.forEach(key => localStorage.removeItem(key));
  try {
    indexedDB.deleteDatabase("freestream-prefetch");
  } catch {
    /* idb unavailable */
  }
  window.dispatchEvent(new CustomEvent("freestream:data-wiped"));
}