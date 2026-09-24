/**
 * Client for the backend account API (`/api/auth/*` on the movie backend).
 *
 * A successfull signup/login returns a bearer token that is persisted in
 * localStorage; every protected request attaches it as `Authorization: Bearer`.
 * Watch history lives per-account on the backend, so switching accounts means
 * switching histories.
 */
import { MOVIE_API_BASE_URL } from "@/services/api";

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  created_at?: string;
}

export interface RemoteHistoryItem {
  movie_key: string;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  media_type: string | null;
  progress_seconds: number;
  duration_seconds: number;
  completed: number;
  watched_at: number;
}

const TOKEN_KEY = "lenium_auth_token";
const USER_KEY = "lenium_auth_user";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): ApiUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as ApiUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: ApiUser): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* storage unavailable */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class AuthApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${MOVIE_API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      /* non-JSON error body */
    }
    throw new AuthApiError(message, response.status);
  }
  return (await response.json()) as T;
}

interface SessionPayload {
  token: string;
  user: ApiUser;
}

export async function apiSignup(input: {
  name: string;
  email: string;
  password: string;
}): Promise<SessionPayload> {
  const payload = await request<SessionPayload>("/api/auth/signup", {
    method: "POST",
    body: input,
  });
  setSession(payload.token, payload.user);
  return payload;
}

export async function apiLogin(input: {
  email: string;
  password: string;
}): Promise<SessionPayload> {
  const payload = await request<SessionPayload>("/api/auth/login", {
    method: "POST",
    body: input,
  });
  setSession(payload.token, payload.user);
  return payload;
}

/** Validate the stored token against the backend; returns the user or null. */
export async function apiMe(): Promise<ApiUser | null> {
  if (!getToken()) return null;
  try {
    const payload = await request<{ user: ApiUser }>("/api/auth/me", { auth: true });
    setSession(getToken() ?? "", payload.user);
    return payload.user;
  } catch (error) {
    if (error instanceof AuthApiError && error.status === 401) {
      clearSession();
      return null;
    }
    // Network hiccup — keep the cached user and optimistic session.
    return getStoredUser();
  }
}

export async function apiLogout(): Promise<void> {
  try {
    await request<{ success: boolean }>("/api/auth/logout", {
      method: "POST",
      auth: true,
    });
  } finally {
    clearSession();
  }
}

export async function apiHistory(): Promise<RemoteHistoryItem[]> {
  const payload = await request<{ history: RemoteHistoryItem[] }>("/api/auth/history", {
    auth: true,
  });
  return payload.history;
}

export async function apiHistoryAdd(item: {
  movie_key: string;
  title: string;
  year?: number | null;
  poster?: string | null;
  backdrop?: string | null;
  media_type?: string | null;
  progress_seconds?: number;
  duration_seconds?: number;
  completed?: boolean;
  watched_at?: number;
}): Promise<void> {
  await request("/api/auth/history", { method: "POST", body: item, auth: true });
}

export async function apiHistoryRemove(movieKey: string): Promise<void> {
  await request(`/api/auth/history/${encodeURIComponent(movieKey)}`, {
    method: "DELETE",
    auth: true,
  });
}

export async function apiHistoryClear(): Promise<void> {
  await request("/api/auth/history", { method: "DELETE", auth: true });
}