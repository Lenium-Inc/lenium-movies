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
  /**
   * The parsed JSON body, when the error response had one.
   *
   * This existed only to read `message` and threw the rest away, so the 429
   * from `/api/allowance/claim` lost the `allowance` object attached to it --
   * including `resets_at`, which is the one thing a viewer needs to know when
   * told they have used today's free titles.
   */
  body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.body = body;
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
    let body: Record<string, unknown> | null = null;
    try {
      const payload = (await response.json()) as {
        error?: string;
        [key: string]: unknown;
      };
      body = payload;
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
    throw new AuthApiError(message, response.status, body);
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

export async function apiHistory(profileId?: string | null): Promise<RemoteHistoryItem[]> {
  // GET has no body, so the profile travels as a query parameter; the backend
  // reads both.
  const query = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
  const payload = await request<{ history: RemoteHistoryItem[] }>(
    `/api/auth/history${query}`,
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
  profile_id?: string | null;
}): Promise<void> {
  await request("/api/auth/history", {
    method: "POST",
    body: item,
    auth: true,
  });
}

export async function apiHistoryRemove(
  movieKey: string,
  profileId?: string | null
): Promise<void> {
  const query = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
  await request(`/api/auth/history/${encodeURIComponent(movieKey)}${query}`, {
    method: "DELETE",
    auth: true,
  });
}

export async function apiHistoryClear(profileId?: string | null): Promise<void> {
  const query = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
  await request(`/api/auth/history${query}`, { method: "DELETE", auth: true });
}

// ---------------------------------------------------------------------------
// Profiles, daily allowance and referrals
// ---------------------------------------------------------------------------

export interface ApiProfile {
  id: string;
  name: string;
  avatar: string;
  avatar_id: string | null;
  is_kids: boolean;
  is_locked: boolean;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// taste & recommendations
// ---------------------------------------------------------------------------

/**
 * Interactions the linear model understands. The weights live server-side; a
 * client that invents a new kind gets a 400 rather than silently widening the
 * vocabulary.
 */
export type TasteKind = "play" | "complete" | "save" | "rate" | "search";

export interface TasteResult {
  ok: boolean;
  /** False when the interaction carried no usable signal. */
  recorded?: boolean;
  /** False when the interaction was counted but not folded into the weights. */
  applied?: boolean;
}

export interface TasteWeights {
  genre: Record<string, number>;
  people: Record<string, number>;
}

export interface TasteStateResponse {
  profile_id: string | number;
  state: TasteWeights;
  model_version: string | null;
  event_count: number;
}

export interface RecommendationResponse {
  results: unknown[];
  /**
   * False when the profile has no usable signal yet, in which case `results` is
   * the untouched upstream list. Callers must not label it as personalised.
   */
  personalised: boolean;
  model_version?: string;
}

/**
 * Held-out evaluation of the model on a profile's own history.
 *
 * `verdict` is the only field to branch on: the scores are meaningless without
 * it, and the endpoint returns them as `null` when there is not enough data to
 * measure anything.
 */
export interface RecommendationEval {
  samples: number;
  train?: number;
  held_out?: number;
  /** Distinct features the model could rank. */
  candidates?: number;
  hit_rate_at_5: number | null;
  /** What a random pick of the same size would score. */
  random_hit_rate: number | null;
  /** The best any ranking could score, given unreachable held-out features. */
  best_possible: number | null;
  /**
   * `better` -- measurably beats random.
   * `not_better` -- enough data, but no better than picking at random.
   * `insufficient_data` -- too few distinct features to measure; this is not a
   *   claim that the model is bad.
   */
  verdict: "better" | "not_better" | "insufficient_data";
  /**
   * Always `self_contained`. The candidate pool is the viewer's own features
   * rather than the real catalogue, so this shows the ordering predicts the
   * viewer's own behaviour and nothing more.
   */
  scope: "self_contained";
}

/**
 * Record one interaction.
 *
 * `query` is only meaningful for `kind: "search"`, and the server drops the
 * text immediately -- it stores a salted fingerprint of the token set, so a
 * repeated private search is recognisable as a habit without the words ever
 * reaching the database.
 */
export async function apiTaste(input: {
  profile_id: string | number;
  kind: TasteKind;
  genres?: string[];
  people?: string[];
  query?: string;
  weight?: number;
}): Promise<TasteResult> {
  return request<TasteResult>("/api/taste", {
    method: "POST",
    body: input,
    auth: true,
  });
}

export async function apiTasteState(
  profileId: string | number
): Promise<TasteStateResponse> {
  return request<TasteStateResponse>(
    `/api/taste/state?profile_id=${encodeURIComponent(profileId)}`,
    { auth: true }
  );
}

/** Replay the event log to rebuild the weight cache. */
export async function apiTasteRebuild(
  profileId: string | number
): Promise<TasteStateResponse> {
  return request<TasteStateResponse>("/api/taste/state", {
    method: "POST",
    body: { profile_id: profileId },
    auth: true,
  });
}

export async function apiRecommendations(input: {
  profile_id: string | number;
  kind?: "trending" | "popular" | "now_playing";
  page?: number;
  limit?: number;
}): Promise<RecommendationResponse> {
  const params = new URLSearchParams();
  params.set("profile_id", String(input.profile_id));
  if (input.kind) params.set("kind", input.kind);
  if (input.page) params.set("page", String(input.page));
  if (input.limit) params.set("limit", String(input.limit));
  return request<RecommendationResponse>(`/api/recommendations?${params}`, {
    auth: true,
  });
}

export async function apiRecommendationEval(
  profileId: string | number
): Promise<RecommendationEval> {
  return request<RecommendationEval>(
    `/api/recommendations/eval?profile_id=${encodeURIComponent(profileId)}`,
    { auth: true }
  );
}

export async function apiProfiles(): Promise<{ profiles: ApiProfile[]; max: number }> {
  const payload = await request<{ profiles: ApiProfile[]; max: number }>(
    "/api/profiles",
    { auth: true }
  );
  return payload;
}

export async function apiProfileCreate(input: {
  name: string;
  avatar?: string;
  avatar_id?: string | null;
  is_kids?: boolean;
  pin?: string;
}): Promise<ApiProfile> {
  const payload = await request<{ profile: ApiProfile }>("/api/profiles", {
    method: "POST",
    body: input,
    auth: true,
  });
  return payload.profile;
}

export async function apiProfileUpdate(
  profileId: string,
  input: {
    name?: string;
    avatar?: string;
    avatar_id?: string | null;
    is_kids?: boolean;
    /** 4-8 digits to set a lock, or "" to remove it. Never read back. */
    pin?: string;
  }
): Promise<ApiProfile> {
  const payload = await request<{ profile: ApiProfile }>(
    `/api/profiles/${encodeURIComponent(profileId)}`,
    { method: "PATCH", body: input, auth: true }
  );
  return payload.profile;
}

export async function apiProfileDelete(profileId: string): Promise<void> {
  await request(`/api/profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
    auth: true,
  });
}

export async function apiProfileUnlock(profileId: string, pin: string): Promise<void> {
  await request(`/api/profiles/${encodeURIComponent(profileId)}/unlock`, {
    method: "POST",
    body: { pin },
    auth: true,
  });
}

export interface DailyAllowance {
  profile_id?: string;
  day: string;
  used: number;
  per_profile_cap: number;
  account_cap: number;
  account_used: number;
  account_left?: number;
  unlocked: boolean;
  unlimited: boolean;
  remaining: number;
  /** ISO instant of the next 00:00 UTC. */
  resets_at: string;
  timezone: "UTC" | string;
}

export async function apiAllowance(profileId?: string | null): Promise<{
  allowance: DailyAllowance;
  profiles: DailyAllowance[];
}> {
  const query = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
  return request<{ allowance: DailyAllowance; profiles: DailyAllowance[] }>(
    `/api/allowance${query}`,
    { auth: true }
  );
}

export interface ReferralStatus {
  code: string;
  accepted: number;
  granted_days: number;
  unlocked_today: boolean;
  unlocks_per_referral: number;
  day: string;
}

export async function apiReferralStatus(): Promise<ReferralStatus> {
  return request<ReferralStatus>("/api/referrals", { auth: true });
}

export async function apiReferralApply(code: string): Promise<ReferralStatus> {
  return request<ReferralStatus>("/api/referrals/apply", {
    method: "POST",
    body: { code },
    auth: true,
  });
}

/**
 * Claim today's allowance for a title.
 *
 * Returns the new allowance on success. On the daily limit it throws an
 * `AuthApiError` with `status` 429 whose message is already written for the
 * viewer, so the player can surface it verbatim instead of inventing a reason.
 */
export async function apiClaimAllowance(
  profileId: string | null,
  movieKey: string
): Promise<{ claimed: boolean; allowance: DailyAllowance }> {
  return request<{ claimed: boolean; allowance: DailyAllowance }>(
    "/api/allowance/claim",
    { method: "POST", body: { profile_id: profileId, movie_key: movieKey }, auth: true }
  );
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
