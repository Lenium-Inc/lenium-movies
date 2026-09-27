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

/**
 * A `fetch` that never produced an HTTP response: DNS failure, a connection the
 * host refused, a TLS problem, or -- most often here -- a blocked CORS preflight.
 *
 * The browser reports every one of those identically, as a bare
 * `TypeError: Failed to fetch`, with the real reason deliberately withheld from
 * page scripts. So the raw error was being surfaced verbatim in the share
 * dialog's error slot, which told the user nothing about *which* request died or
 * *why*. It is worth reconstructing the likely cause: on a POST carrying
 * `Content-Type: application/json` and `Authorization`, the browser sends an
 * `OPTIONS` preflight first, and if that comes back non-2xx (an older deploy
 * that predates the route answers 404) or omits the CORS headers entirely, the
 * real request is never sent and the failure surfaces here even though the
 * endpoint is perfectly healthy.
 */
export class AuthNetworkError extends Error {
  /** The fully-resolved URL that was requested, base origin included. */
  url: string;
  constructor(url: string, method: string) {
    const origin = MOVIE_API_BASE_URL || "this origin (relative request)";
    super(
      `Could not reach the account API at ${origin} — the browser blocked the ` +
        "response, so this is a network or CORS fault rather than a rejected " +
        "request. The backend may be asleep, or deployed from a build older " +
        "than this route. Details are in the console."
    );
    this.name = "AuthNetworkError";
    this.url = url;
    // The cause is invisible to page scripts, and the full URL is what makes
    // "which deployment?" answerable, so it goes to the console rather than
    // being crammed into a dialog's one-line error slot.
    console.error(
      `[auth] ${method} ${url} never reached the app. The ` +
        "request had no HTTP response: the origin is unreachable, or an OPTIONS " +
        "preflight for it did not return 2xx with matching CORS headers. A " +
        "deploy that predates this route answers the preflight with 404, which " +
        "fails the request even though the endpoint is correct on the current " +
        "code. Checked origin: " +
        `${origin}. (VITE_MOVIE_API_BASE_URL is inlined at build time.)`
    );
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const url = `${MOVIE_API_BASE_URL}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (cause) {
    // Only a genuine transport failure reaches this branch; an HTTP error
    // status is a normal response and is handled below.
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;
    throw new AuthNetworkError(url, options.method ?? "GET");
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      /* non-JSON error body */
    }
    // A 401 on an authenticated request means the stored token is expired,
    // revoked, or simply garbage. Sessions last 30 days server-side, so a token
    // can outlive its server row and then linger in localStorage forever.
    //
    // Nothing in the list or sharing paths used to clear it, and
    // `hasRemoteSession()` is only a string-presence check -- so a dead token
    // left the UI showing a Share button and a list that silently never syncs,
    // with no way for the user to tell. Clearing here means the next render
    // drops back to signed-out instead of pretending to be signed in.
    if (options.auth && response.status === 401) {
      clearSession();
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
    const payload = await request<{ user: ApiUser }>("/api/auth/me", {
      auth: true,
    });
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
  const payload = await request<{ history: RemoteHistoryItem[] }>(
    "/api/auth/history",
    {
      auth: true,
    }
  );
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
  await request("/api/auth/history", {
    method: "POST",
    body: item,
    auth: true,
  });
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

// ---------------------------------------------------------------------------
// Saved media ("My List", backed by the Postgres `saved_media` table)
// ---------------------------------------------------------------------------

export interface SavedMediaItem {
  media_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  created_at: string | null;
}

export async function apiSavedMedia(): Promise<SavedMediaItem[]> {
  const payload = await request<{ items: SavedMediaItem[] }>(
    "/api/auth/my-list",
    { auth: true }
  );
  return payload.items;
}

export async function apiSavedMediaAdd(item: {
  media_id: number;
  media_type?: "movie" | "tv";
  title?: string;
  poster_path?: string | null;
}): Promise<boolean> {
  const payload = await request<{ added: boolean }>("/api/auth/my-list", {
    method: "POST",
    body: item,
    auth: true,
  });
  return payload.added;
}

export async function apiSavedMediaRemove(mediaId: number): Promise<void> {
  await request(`/api/auth/my-list/${mediaId}`, {
    method: "DELETE",
    auth: true,
  });
}

// ---------------------------------------------------------------------------
// Sharing
//
// `request` attaches the bearer token when `auth` is true, and omits it
// entirely when no session exists, so a signed-out visitor can still render an
// invite. Credentials are sent on the preview call for that same reason: the
// server needs to know who is asking in order to say "you already have access"
// instead of rejecting a link the viewer legitimately holds.
// ---------------------------------------------------------------------------

export interface ShareInvite {
  token: string;
  email: string | null;
  role: "viewer" | "editor";
  status: "pending" | "accepted" | "revoked" | "expired";
  created_at: string | null;
  expires_at: string | null;
  accepted_at: string | null;
}

export interface ShareMember {
  user_id: string;
  display_name: string;
  role: "viewer" | "editor";
  /** Only ever populated for the list owner. Other members get null. */
  email: string | null;
  joined_at: string | null;
}

export interface SharedProfile {
  owner_id: string;
  owner_name: string;
  role: "viewer" | "editor";
}

export interface ShareInvitePreview {
  inviter_name: string;
  item_count: number;
  role: "viewer" | "editor";
  expires_at: string | null;
  already_member?: boolean;
  is_owner?: boolean;
}

export async function apiCreateShare(input?: {
  email?: string | null;
  role?: "viewer" | "editor";
}): Promise<{ share: ShareInvite; reused: boolean }> {
  return request("/api/auth/shares", {
    method: "POST",
    body: input ?? {},
    auth: true,
  });
}

export async function apiShares(): Promise<{
  invites: ShareInvite[];
  members: ShareMember[];
  shared_with_me: SharedProfile[];
}> {
  return request("/api/auth/shares", { auth: true });
}

export async function apiSharePreview(
  token: string
): Promise<ShareInvitePreview> {
  return request(`/api/auth/shares/${encodeURIComponent(token)}`, {
    auth: true,
  });
}

export async function apiAcceptShare(token: string): Promise<void> {
  await request(`/api/auth/shares/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    auth: true,
  });
}

export async function apiRevokeShare(token: string): Promise<void> {
  await request(`/api/auth/shares/${encodeURIComponent(token)}/revoke`, {
    method: "POST",
    auth: true,
  });
}

export async function apiShareMembers(token: string): Promise<ShareMember[]> {
  const payload = await request<{ members: ShareMember[] }>(
    `/api/auth/shares/${encodeURIComponent(token)}/members`,
    { auth: true }
  );
  return payload.members;
}

export async function apiRemoveShareMember(
  token: string,
  userId: string
): Promise<void> {
  await request(
    `/api/auth/shares/${encodeURIComponent(token)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE", auth: true }
  );
}

/** Read someone else's saved list. The server rejects non-members with 403. */
export async function apiSharedSavedMedia(ownerId: string): Promise<{
  items: SavedMediaItem[];
  owner: string;
}> {
  return request(`/api/auth/shared/${encodeURIComponent(ownerId)}/my-list`, {
    auth: true,
  });
}
