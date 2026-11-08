/**
 * Account, profile, share and preference API for the Vite app.
 *
 * The catalogue lives on the external MovieBox API. Everything that has to
 * remember something about a viewer lives here, backed by the Neon Postgres
 * database provisioned for this project. The route shapes and payloads match
 * the Flask backend the client was originally written against, so the browser
 * and the Android build did not need a second client.
 *
 * This is a Node function (not Edge) because password hashing and the `pg`
 * driver need the Node runtime. `DATABASE_URL` is injected by Vercel.
 */

import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import pg, { type PoolConfig } from "pg";

const { Pool } = pg;

type Row = Record<string, any>;

type HandlerRequest = {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined> & {
    get?: (name: string) => string | null;
  };
  body?: unknown;
};

type HandlerResponse = {
  status(code: number): HandlerResponse;
  json(body: unknown): void;
  send(body?: unknown): void;
  end(): void;
  setHeader(name: string, value: string | string[]): void;
  headersSent?: boolean;
};

const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 210_000;
const MAX_PROFILES = 4;
const DAILY_TITLE_CAP = 10;
const DAILY_ACCOUNT_CAP = 20;
const REFERRAL_UNLOCKS_PER_ACCEPT = 1;
const MAX_PENDING_INVITES = 20;
const HISTORY_MAX_SECONDS = 60 * 60 * 12;
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://streamvy.me",
  "https://www.streamvy.me",
  "https://streamvy.vercel.app",
  "https://vy-virid.vercel.app",
  // Capacitor serves the bundled SPA from these origins on Android.
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5193",
  "http://127.0.0.1:5193",
];

function databaseUrl(): string {
  return (process.env.DATABASE_URL || "").trim();
}

function poolOptions(): PoolConfig {
  const raw = databaseUrl();
  if (!raw) return { connectionString: raw };
  try {
    const parsed = new URL(raw);
    const needsSsl = /neon\.tech$/i.test(parsed.hostname);
    // `pg` warns about `sslmode=require`; setting `ssl` explicitly is the same
    // posture without the warning on every cold start.
    parsed.searchParams.delete("sslmode");
    return {
      connectionString: parsed.toString(),
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    };
  } catch {
    return { connectionString: raw };
  }
}

const pool = new Pool(poolOptions());

function query(text: string, params: unknown[] = []): Promise<pg.QueryResult<Row>> {
  return pool.query<Row>(text, params);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isExpired(value: unknown): boolean {
  if (!value) return true;
  const date = value instanceof Date ? value : new Date(String(value));
  return !Number.isFinite(date.getTime()) || Date.now() > date.getTime();
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnightIso(): string {
  const date = new Date();
  date.setUTCHours(24, 0, 0, 0);
  return date.toISOString();
}

function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

function header(req: HandlerRequest, name: string): string {
  const value = req.headers?.[name] ?? req.headers?.get?.(name);
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

function bearer(req: HandlerRequest): string {
  const value = header(req, "authorization");
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function allowedOrigins(): Set<string> {
  const configured = (process.env.ALLOWED_ORIGINS || "").trim();
  const values = configured ? configured.split(",") : DEFAULT_ALLOWED_ORIGINS;
  return new Set(
    values.map(value => value.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean)
  );
}

function corsHeaders(req: HandlerRequest): Record<string, string> {
  const origin = header(req, "origin").trim().replace(/\/+$/, "").toLowerCase();
  if (!origin || !allowedOrigins().has(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function sendJson(
  req: HandlerRequest,
  res: HandlerResponse,
  status: number,
  payload: unknown,
  extra: Record<string, string> = {}
): void {
  res.status(status);
  for (const [name, value] of Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req),
    ...extra,
  })) {
    res.setHeader(name, value);
  }
  res.json(payload);
}

function fail(
  req: HandlerRequest,
  res: HandlerResponse,
  message: string,
  status = 401,
  extra: Record<string, unknown> = {}
): void {
  sendJson(req, res, status, { error: message, success: false, ...extra });
}

function bodyOf(req: HandlerRequest): Row {
  let value: unknown = req.body;
  if (Buffer.isBuffer(value)) {
    try {
      value = JSON.parse(value.toString("utf8"));
    } catch {
      value = {};
    }
  }
  // The client historically stringified the delete-account body before handing
  // it to a wrapper that stringifies again, so accept a double-encoded string.
  for (let i = 0; i < 2 && typeof value === "string"; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function serializeUser(user: Row | null | undefined): Row | null {
  if (!user) return null;
  return {
    id: String(user.id),
    email: user.email,
    name: user.display_name || user.name || "",
    created_at: toIso(user.created_at),
    is_admin: isAdminEmail(user.email),
  };
}

function serializeProfile(profile: Row): Row {
  return {
    id: String(profile.id),
    name: profile.name || "",
    avatar: profile.avatar || "",
    avatar_id: profile.avatar_id ?? null,
    is_kids: Boolean(profile.is_kids),
    is_locked: Boolean(profile.is_locked),
    sort_order: Number(profile.sort_order || 0),
  };
}

function isAdminEmail(email: unknown): boolean {
  if (!email) return false;
  const allowlist = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
  return allowlist.has(String(email).trim().toLowerCase());
}

function hashSecret(secret: string, salt: string): string {
  const raw = pbkdf2Sync(secret, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return `pbkdf2_sha256$${salt}$${raw.toString("hex")}`;
}

function hashPassword(password: string): string {
  return hashSecret(password, randomHex(16));
}

function verifySecret(secret: string, stored: string, legacySalt = ""): boolean {
  if (!secret || !stored) return false;
  let salt = legacySalt;
  let expected = stored;
  if (stored.includes("$")) {
    const parts = stored.split("$");
    if (parts.length !== 3) return false;
    salt = parts[1];
    expected = parts[2];
  }
  if (!salt || !/^[0-9a-f]+$/i.test(expected)) return false;
  const actual = pbkdf2Sync(secret, salt, PASSWORD_ITERATIONS, 32, "sha256");
  const wanted = Buffer.from(expected.toLowerCase(), "hex");
  return wanted.length === actual.length && timingSafeEqual(actual, wanted);
}

function referralCode(userId: unknown): string {
  const digest = createHash("sha256")
    .update(`lenium-referral:${String(userId)}`)
    .digest()
    .subarray(0, 8);
  const body = Array.from(digest)
    .map(byte => REFERRAL_ALPHABET[byte % REFERRAL_ALPHABET.length])
    .join("");
  return `LM${body}`;
}

async function createSession(userId: unknown): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, isoPlusDays(SESSION_TTL_DAYS)]
  );
  return token;
}

async function authUser(req: HandlerRequest): Promise<Row | null> {
  const token = bearer(req);
  if (!token) return null;
  const result = await query(
    "SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token = $1 LIMIT 1",
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (isExpired(row.expires_at)) {
    await query("DELETE FROM sessions WHERE token = $1", [token]);
    return null;
  }
  return row;
}

async function listProfiles(userId: unknown): Promise<Row[]> {
  const result = await query(
    "SELECT * FROM watch_profiles WHERE user_id = $1 " +
      "ORDER BY sort_order ASC, created_at ASC",
    [userId]
  );
  return result.rows;
}

async function profileById(profileId: string, userId: unknown): Promise<Row | null> {
  if (!UUID_RE.test(profileId)) return null;
  const result = await query(
    "SELECT * FROM watch_profiles WHERE id = $1 AND user_id = $2 LIMIT 1",
    [profileId, userId]
  );
  return result.rows[0] ?? null;
}

async function resolveProfile(
  user: Row,
  payload: Row = {},
  search?: URLSearchParams
): Promise<Row | null | false> {
  const raw = payload.profile_id ?? search?.get("profile_id") ?? "";
  if (raw == null || raw === "") {
    const profiles = await listProfiles(user.id);
    return profiles[0] ?? null;
  }
  return (await profileById(String(raw), user.id)) ?? false;
}

async function countProfiles(userId: unknown): Promise<number> {
  const result = await query(
    "SELECT COUNT(*)::int AS n FROM watch_profiles WHERE user_id = $1",
    [userId]
  );
  return Number(result.rows[0]?.n || 0);
}

async function playsOn(profileId: unknown, day: string): Promise<number> {
  const result = await query(
    "SELECT COUNT(*)::int AS n FROM daily_plays WHERE profile_id = $1 AND day = $2",
    [profileId, day]
  );
  return Number(result.rows[0]?.n || 0);
}

async function accountPlaysOn(userId: unknown, day: string): Promise<number> {
  const result = await query(
    "SELECT COUNT(*)::int AS n FROM daily_plays d " +
      "JOIN watch_profiles p ON p.id = d.profile_id " +
      "WHERE p.user_id = $1 AND d.day = $2",
    [userId, day]
  );
  return Number(result.rows[0]?.n || 0);
}

async function claimedToday(
  profileId: unknown,
  day: string,
  movieKey: string
): Promise<boolean> {
  const result = await query(
    "SELECT 1 AS hit FROM daily_plays " +
      "WHERE profile_id = $1 AND day = $2 AND movie_key = $3 LIMIT 1",
    [profileId, day, movieKey]
  );
  return result.rowCount === 1;
}

async function recordPlay(
  profileId: unknown,
  day: string,
  movieKey: string,
  userId: unknown,
  enforceCaps = true
): Promise<boolean> {
  if (!enforceCaps) {
    await query(
      "INSERT INTO daily_plays (profile_id, day, movie_key, played_at) " +
        "VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [profileId, day, movieKey, Date.now()]
    );
    return true;
  }
  const result = await query(
    "INSERT INTO daily_plays (profile_id, day, movie_key, played_at) " +
      "SELECT $1, $2, $3, $4 " +
      "WHERE (SELECT COUNT(*) FROM daily_plays WHERE profile_id = $1 AND day = $2) < $5 " +
      "AND (SELECT COUNT(*) FROM daily_plays d " +
      "     JOIN watch_profiles p ON p.id = d.profile_id " +
      "     WHERE p.user_id = $6 AND d.day = $2) < $7 " +
      "ON CONFLICT DO NOTHING",
    [profileId, day, movieKey, Date.now(), DAILY_TITLE_CAP, userId, DAILY_ACCOUNT_CAP]
  );
  return result.rowCount === 1;
}

async function hasUnlockedDay(userId: unknown, day: string): Promise<boolean> {
  const result = await query(
    "SELECT 1 AS ok FROM referral_grants WHERE owner_id = $1 AND day = $2 LIMIT 1",
    [userId, day]
  );
  return result.rowCount === 1;
}

async function grantDay(userId: unknown, day: string): Promise<boolean> {
  const result = await query(
    "INSERT INTO referral_grants (owner_id, day, source) VALUES ($1, $2, 'referral') " +
      "ON CONFLICT (owner_id, day) DO NOTHING",
    [userId, day]
  );
  return result.rowCount === 1;
}

async function allowanceFor(
  user: Row,
  profile: Row
): Promise<Row> {
  const day = utcToday();
  const unlocked = await hasUnlockedDay(user.id, day);
  const used = await playsOn(profile.id, day);
  const accountUsed = await accountPlaysOn(user.id, day);
  const accountLeft = Math.max(0, DAILY_ACCOUNT_CAP - accountUsed);
  const effective = unlocked
    ? 1_000_000
    : Math.min(DAILY_TITLE_CAP, accountLeft + used);
  return {
    profile_id: String(profile.id),
    day,
    used,
    per_profile_cap: DAILY_TITLE_CAP,
    account_cap: DAILY_ACCOUNT_CAP,
    account_used: accountUsed,
    account_left: accountLeft,
    unlocked,
    unlimited: unlocked,
    remaining: unlocked ? 1_000_000 : Math.max(0, effective - used),
    resets_at: nextUtcMidnightIso(),
    timezone: "UTC",
  };
}

async function referralCodeFor(userId: unknown): Promise<string> {
  const existing = await query(
    "SELECT code FROM referral_codes WHERE owner_id = $1 LIMIT 1",
    [userId]
  );
  if (existing.rows[0]) return String(existing.rows[0].code);
  const code = referralCode(userId);
  await query(
    "INSERT INTO referral_codes (owner_id, code) VALUES ($1, $2) " +
      "ON CONFLICT (code) DO NOTHING",
    [userId, code]
  );
  const after = await query(
    "SELECT code FROM referral_codes WHERE owner_id = $1 LIMIT 1",
    [userId]
  );
  return String(after.rows[0]?.code || code);
}

async function grantedDays(userId: unknown): Promise<number> {
  const result = await query(
    "SELECT COUNT(*)::int AS n FROM referral_grants WHERE owner_id = $1",
    [userId]
  );
  return Number(result.rows[0]?.n || 0);
}

async function referralStats(userId: unknown): Promise<Row> {
  const code = await referralCodeFor(userId);
  const accepted = await query(
    "SELECT COUNT(*)::int AS n FROM referral_uses u " +
      "JOIN referral_codes c ON c.id = u.code_id WHERE c.owner_id = $1",
    [userId]
  );
  return {
    code,
    accepted: Number(accepted.rows[0]?.n || 0),
    granted_days: await grantedDays(userId),
  };
}

async function acceptReferral(userId: unknown, code: string): Promise<boolean> {
  const found = await query("SELECT owner_id FROM referral_codes WHERE code = $1 LIMIT 1", [
    code.trim().toUpperCase(),
  ]);
  const row = found.rows[0];
  if (!row) return false;
  if (String(row.owner_id) === String(userId)) return false;
  const inserted = await query(
    "INSERT INTO referral_uses (code_id, referred_id) " +
      "SELECT id, $2 FROM referral_codes WHERE code = $1 " +
      "ON CONFLICT DO NOTHING",
    [code.trim().toUpperCase(), userId]
  );
  return inserted.rowCount === 1;
}

async function referrerOf(userId: unknown): Promise<string | null> {
  const result = await query(
    "SELECT c.owner_id AS owner_id FROM referral_uses u " +
      "JOIN referral_codes c ON c.id = u.code_id WHERE u.referred_id = $1 LIMIT 1",
    [userId]
  );
  return result.rows[0]?.owner_id ? String(result.rows[0].owner_id) : null;
}

async function addHistory(
  userId: unknown,
  movieKey: string,
  fields: Row,
  profileId: unknown
): Promise<void> {
  const values = {
    title: fields.title,
    year: fields.year,
    poster: fields.poster,
    backdrop: fields.backdrop,
    media_type: fields.media_type,
  };
  const progress = Number(fields.progress_seconds || 0);
  const duration = Number(fields.duration_seconds || 0);
  const completed = fields.completed ? 1 : 0;
  const watchedAt = Number(fields.watched_at || Date.now());

  if (profileId) {
    await query(
      "INSERT INTO watch_history " +
        "(user_id, profile_id, movie_key, title, year, poster, backdrop, media_type, " +
        " progress_seconds, duration_seconds, completed, watched_at, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) " +
        "ON CONFLICT (user_id, profile_id, movie_key) DO UPDATE SET " +
        "title = EXCLUDED.title, year = EXCLUDED.year, poster = EXCLUDED.poster, " +
        "backdrop = EXCLUDED.backdrop, media_type = EXCLUDED.media_type, " +
        "progress_seconds = EXCLUDED.progress_seconds, " +
        "duration_seconds = EXCLUDED.duration_seconds, completed = EXCLUDED.completed, " +
        "watched_at = EXCLUDED.watched_at, updated_at = EXCLUDED.updated_at",
      [
        userId,
        profileId,
        movieKey,
        values.title,
        values.year,
        values.poster,
        values.backdrop,
        values.media_type,
        progress,
        duration,
        completed,
        watchedAt,
        nowIso(),
      ]
    );
    return;
  }

  const existing = await query(
    "SELECT id FROM watch_history WHERE user_id = $1 AND movie_key = $2 " +
      "AND profile_id IS NULL LIMIT 1",
    [userId, movieKey]
  );
  if (existing.rows[0]) {
    await query(
      "UPDATE watch_history SET title = $1, year = $2, poster = $3, backdrop = $4, " +
        "media_type = $5, progress_seconds = $6, duration_seconds = $7, completed = $8, " +
        "watched_at = $9, updated_at = $10 WHERE id = $11",
      [
        values.title,
        values.year,
        values.poster,
        values.backdrop,
        values.media_type,
        progress,
        duration,
        completed,
        watchedAt,
        nowIso(),
        existing.rows[0].id,
      ]
    );
    return;
  }
  await query(
    "INSERT INTO watch_history " +
      "(user_id, profile_id, movie_key, title, year, poster, backdrop, media_type, " +
      " progress_seconds, duration_seconds, completed, watched_at, updated_at) " +
      "VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [
      userId,
      movieKey,
      values.title,
      values.year,
      values.poster,
      values.backdrop,
      values.media_type,
      progress,
      duration,
      completed,
      watchedAt,
      nowIso(),
    ]
  );
}

function cleanText(payload: Row, key: string, limit: number): string | null {
  const raw = payload[key];
  if (raw == null || !["string", "number"].includes(typeof raw)) return null;
  const value = String(raw).trim().slice(0, limit);
  return value || null;
}

function cleanInt(
  payload: Row,
  key: string,
  fallback: number,
  low: number,
  high: number
): number {
  const raw = payload[key];
  if (raw == null || typeof raw === "boolean") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(low, Math.min(high, parsed));
}

function cleanHistoryFields(payload: Row): { fields: Row } | { error: string } {
  const rawKey = payload.movie_key ?? payload.id;
  if (rawKey == null || ["boolean", "object"].includes(typeof rawKey)) {
    return { error: "Missing movie key." };
  }
  const movieKey = String(rawKey).trim().slice(0, 200);
  if (!movieKey) return { error: "Missing movie key." };

  let year: number | null = null;
  if (payload.year != null && payload.year !== "") {
    const parsed = Number.parseInt(String(payload.year), 10);
    if (Number.isFinite(parsed)) year = Math.max(1800, Math.min(2200, parsed));
  }

  return {
    fields: {
      movie_key: movieKey,
      title: cleanText(payload, "title", 300) || movieKey,
      year,
      poster: cleanText(payload, "poster", 2048),
      backdrop: cleanText(payload, "backdrop", 2048),
      media_type: payload.media_type === "tv" ? "tv" : "movie",
      progress_seconds: cleanInt(payload, "progress_seconds", 0, 0, HISTORY_MAX_SECONDS),
      duration_seconds: cleanInt(payload, "duration_seconds", 0, 0, HISTORY_MAX_SECONDS),
      completed: payload.completed ? 1 : 0,
      watched_at: cleanInt(payload, "watched_at", Date.now(), 0, Number.MAX_SAFE_INTEGER),
    },
  };
}

function shareView(invite: Row, includeEmail: boolean): Row {
  return {
    token: invite.token,
    email: includeEmail ? invite.email ?? null : null,
    role: invite.role || "viewer",
    status: invite.status || "pending",
    created_at: toIso(invite.created_at),
    expires_at: toIso(invite.expires_at),
    accepted_at: toIso(invite.accepted_at),
  };
}

function memberViews(rows: Row[], requesterId: unknown, ownerId: unknown): Row[] {
  const isOwner = String(ownerId) === String(requesterId);
  return rows.map(row => ({
    user_id: String(row.user_id),
    display_name: row.display_name || "Viewer",
    role: row.role || "viewer",
    email: isOwner ? row.email ?? null : null,
    joined_at: toIso(row.created_at),
  }));
}

async function deleteUser(userId: unknown): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM taste_events WHERE profile_id IN " +
        "(SELECT id FROM watch_profiles WHERE user_id = $1)",
      [userId]
    );
    await client.query(
      "DELETE FROM taste_signals WHERE profile_id IN " +
        "(SELECT id FROM watch_profiles WHERE user_id = $1)",
      [userId]
    );
    await client.query(
      "DELETE FROM daily_plays WHERE profile_id IN " +
        "(SELECT id FROM watch_profiles WHERE user_id = $1)",
      [userId]
    );
    await client.query("DELETE FROM watch_history WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM watch_profiles WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM saved_media WHERE user_id = $1", [userId]);
    await client.query(
      "DELETE FROM share_members WHERE user_id = $1 OR owner_id = $1",
      [userId]
    );
    await client.query(
      "DELETE FROM referral_uses WHERE referred_id = $1 OR code_id IN " +
        "(SELECT id FROM referral_codes WHERE owner_id = $1)",
      [userId]
    );
    await client.query("DELETE FROM referral_grants WHERE owner_id = $1", [userId]);
    await client.query("DELETE FROM referral_codes WHERE owner_id = $1", [userId]);
    await client.query("DELETE FROM share_invites WHERE owner_id = $1", [userId]);
    await client.query(
      "UPDATE share_invites SET accepted_by = NULL WHERE accepted_by = $1",
      [userId]
    );
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    const result = await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleAuth(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  search: URLSearchParams,
  method: string
): Promise<boolean> {
  const action = parts[1] || "";

  if (action === "signup" && method === "POST") {
    const body = bodyOf(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    const password = String(body.password ?? "");
    if (!EMAIL_RE.test(email)) {
      fail(req, res, "Please enter a valid email address.", 400);
      return true;
    }
    if (password.length < 8) {
      fail(req, res, "Password must be at least 8 characters.", 400);
      return true;
    }
    if (!name) {
      fail(req, res, "Please enter your name.", 400);
      return true;
    }
    const existing = await query("SELECT id FROM users WHERE email = $1 LIMIT 1", [email]);
    if (existing.rowCount) {
      fail(req, res, "An account with this email already exists.", 409);
      return true;
    }
    let user: Row;
    try {
      const inserted = await query(
        "INSERT INTO users (email, display_name, password_hash) " +
          "VALUES ($1, $2, $3) RETURNING *",
        [email, name.slice(0, 80), hashPassword(password)]
      );
      user = inserted.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        fail(req, res, "An account with this email already exists.", 409);
        return true;
      }
      throw error;
    }
    const token = await createSession(user.id);
    sendJson(req, res, 201, { success: true, token, user: serializeUser(user) });
    return true;
  }

  if (action === "login" && method === "POST") {
    const body = bodyOf(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const found = await query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
    const user = found.rows[0];
    if (!user || !verifySecret(password, user.password_hash, user.password_salt || "")) {
      fail(req, res, "Incorrect email or password.");
      return true;
    }
    const token = await createSession(user.id);
    sendJson(req, res, 200, { success: true, token, user: serializeUser(user) });
    return true;
  }

  if (action === "me" && method === "GET") {
    const user = await authUser(req);
    if (!user) {
      fail(req, res, "Not signed in.");
      return true;
    }
    sendJson(req, res, 200, { user: serializeUser(user) });
    return true;
  }

  if (action === "logout" && method === "POST") {
    const token = bearer(req);
    if (token) await query("DELETE FROM sessions WHERE token = $1", [token]);
    sendJson(req, res, 200, { success: true });
    return true;
  }

  if (action === "account" && method === "DELETE") {
    const user = await authUser(req);
    if (!user) {
      fail(req, res, "Sign in to delete your account.");
      return true;
    }
    const body = bodyOf(req);
    if (String(body.email ?? "").trim().toLowerCase() !== String(user.email).toLowerCase()) {
      fail(req, res, "Confirm the email address on the account.", 400);
      return true;
    }
    if (!body.password) {
      fail(req, res, "Enter your password to delete the account.", 400);
      return true;
    }
    if (!verifySecret(String(body.password), user.password_hash, user.password_salt || "")) {
      fail(req, res, "That password did not match.", 401);
      return true;
    }
    const deleted = await deleteUser(user.id);
    if (!deleted) {
      fail(req, res, "Could not delete the account. Try again.", 500);
      return true;
    }
    sendJson(req, res, 200, { success: true });
    return true;
  }

  if (action === "history" && !parts[2]) {
    const user = await authUser(req);
    if (!user) {
      fail(req, res, "Sign in to sync your watch history.");
      return true;
    }
    const body = bodyOf(req);
    const profile = await resolveProfile(user, body, search);
    if (profile === false) {
      fail(req, res, "Unknown profile.", 403);
      return true;
    }
    const profileId = profile ? profile.id : null;

    if (method === "DELETE") {
      if (profileId) {
        await query("DELETE FROM watch_history WHERE user_id = $1 AND profile_id = $2", [
          user.id,
          profileId,
        ]);
      } else {
        await query("DELETE FROM watch_history WHERE user_id = $1", [user.id]);
      }
      sendJson(req, res, 200, { success: true });
      return true;
    }

    if (method === "POST") {
      const cleaned = cleanHistoryFields(body);
      if ("error" in cleaned) {
        fail(req, res, cleaned.error, 400);
        return true;
      }
      await addHistory(user.id, cleaned.fields.movie_key, cleaned.fields, profileId);
      sendJson(req, res, 200, { success: true });
      return true;
    }

    const result = profileId
      ? await query(
          "SELECT movie_key, title, year, poster, backdrop, media_type, " +
            "progress_seconds, duration_seconds, completed, watched_at " +
            "FROM watch_history WHERE user_id = $1 AND profile_id = $2 " +
            "ORDER BY watched_at DESC LIMIT 100",
          [user.id, profileId]
        )
      : await query(
          "SELECT movie_key, title, year, poster, backdrop, media_type, " +
            "progress_seconds, duration_seconds, completed, watched_at " +
            "FROM watch_history WHERE user_id = $1 AND profile_id IS NULL " +
            "ORDER BY watched_at DESC LIMIT 100",
          [user.id]
        );
    sendJson(req, res, 200, {
      history: result.rows.map(row => ({
        ...row,
        progress_seconds: Number(row.progress_seconds || 0),
        duration_seconds: Number(row.duration_seconds || 0),
        completed: Number(row.completed || 0),
        watched_at: Number(row.watched_at || 0),
      })),
      profile_id: profileId ? String(profileId) : null,
    });
    return true;
  }

  if (action === "history" && parts[2] && method === "DELETE") {
    const user = await authUser(req);
    if (!user) {
      fail(req, res, "Sign in to manage your watch history.");
      return true;
    }
    const profile = await resolveProfile(user, bodyOf(req), search);
    if (profile === false) {
      fail(req, res, "Unknown profile.", 403);
      return true;
    }
    if (profile) {
      await query(
        "DELETE FROM watch_history WHERE user_id = $1 AND movie_key = $2 AND profile_id = $3",
        [user.id, parts[2], profile.id]
      );
    } else {
      await query(
        "DELETE FROM watch_history WHERE user_id = $1 AND movie_key = $2 AND profile_id IS NULL",
        [user.id, parts[2]]
      );
    }
    sendJson(req, res, 200, { success: true });
    return true;
  }

  if (action === "my-list") {
    const user = await authUser(req);
    if (!user) {
      fail(req, res, "Sign in to sync your saved list.");
      return true;
    }
    if (method === "DELETE" && !parts[2]) {
      await query("DELETE FROM saved_media WHERE user_id = $1", [user.id]);
      sendJson(req, res, 200, { success: true });
      return true;
    }
    if (method === "DELETE" && parts[2]) {
      const mediaId = Number.parseInt(parts[2], 10);
      if (!Number.isFinite(mediaId)) {
        fail(req, res, "Missing a valid media id.", 400);
        return true;
      }
      await query("DELETE FROM saved_media WHERE user_id = $1 AND media_id = $2", [
        user.id,
        mediaId,
      ]);
      sendJson(req, res, 200, { success: true });
      return true;
    }
    if (method === "POST") {
      const body = bodyOf(req);
      const mediaId = Number.parseInt(String(body.media_id ?? body.id ?? ""), 10);
      if (!Number.isFinite(mediaId)) {
        fail(req, res, "Missing a valid media id.", 400);
        return true;
      }
      const mediaType = body.media_type === "tv" ? "tv" : "movie";
      const title = String(body.title ?? "").trim();
      const poster = body.poster_path ?? body.poster_url ?? null;
      const inserted = await query(
        "INSERT INTO saved_media (user_id, media_id, media_type, title, poster_path) " +
          "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, media_id, media_type) DO NOTHING",
        [user.id, mediaId, mediaType, title, poster ? String(poster) : ""]
      );
      sendJson(req, res, 200, { success: true, added: inserted.rowCount === 1 });
      return true;
    }
    const result = await query(
      "SELECT media_id, media_type, title, poster_path, created_at " +
        "FROM saved_media WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500",
      [user.id]
    );
    sendJson(req, res, 200, {
      items: result.rows.map(row => ({
        media_id: Number(row.media_id),
        media_type: row.media_type || "movie",
        title: row.title || "",
        poster_path: row.poster_path || null,
        created_at: toIso(row.created_at),
      })),
    });
    return true;
  }

  if (action === "shares") {
    return handleShares(req, res, parts, method);
  }

  if (
    action === "shared" &&
    parts.length === 4 &&
    parts[3] === "my-list" &&
    method === "GET"
  ) {
    const user = await authUser(req);
    if (!user) {
      fail(req, res, "Sign in to see shared lists.");
      return true;
    }
    const ownerId = parts[2];
    if (!UUID_RE.test(ownerId)) {
      fail(req, res, "You do not have access to this list.", 403);
      return true;
    }
    if (String(ownerId) === String(user.id)) {
      const items = await query(
        "SELECT media_id, media_type, title, poster_path, created_at " +
          "FROM saved_media WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500",
        [ownerId]
      );
      sendJson(req, res, 200, {
        items: items.rows.map(row => ({
          media_id: Number(row.media_id),
          media_type: row.media_type || "movie",
          title: row.title || "",
          poster_path: row.poster_path || null,
          created_at: toIso(row.created_at),
        })),
        owner: "you",
      });
      return true;
    }
    const member = await query(
      "SELECT 1 AS ok FROM share_members WHERE owner_id = $1 AND user_id = $2 LIMIT 1",
      [ownerId, user.id]
    );
    if (!member.rowCount) {
      fail(req, res, "You do not have access to this list.", 403);
      return true;
    }
    const owner = await query("SELECT display_name FROM users WHERE id = $1 LIMIT 1", [
      ownerId,
    ]);
    const items = await query(
      "SELECT media_id, media_type, title, poster_path, created_at " +
        "FROM saved_media WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500",
      [ownerId]
    );
    sendJson(req, res, 200, {
      items: items.rows.map(row => ({
        media_id: Number(row.media_id),
        media_type: row.media_type || "movie",
        title: row.title || "",
        poster_path: row.poster_path || null,
        created_at: toIso(row.created_at),
      })),
      owner: owner.rows[0]?.display_name || "Someone",
    });
    return true;
  }

  return false;
}

async function handleShares(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  method: string
): Promise<boolean> {
  const user = await authUser(req);

  if (parts.length === 2) {
    if (!user) {
      fail(req, res, "Sign in to share your list.");
      return true;
    }
    if (method === "POST") {
      const body = bodyOf(req);
      const email = String(body.email ?? "").trim().toLowerCase() || null;
      const role = body.role === "editor" ? "editor" : "viewer";
      if (body.role && !["viewer", "editor"].includes(String(body.role))) {
        fail(req, res, "Role must be viewer or editor.", 400);
        return true;
      }
      const existing = await query(
        "SELECT * FROM share_invites WHERE owner_id = $1 AND status = 'pending' " +
          "AND COALESCE(email, '') = $2 AND role = $3 ORDER BY created_at DESC LIMIT 1",
        [user.id, email || "", role]
      );
      if (existing.rows[0]) {
        sendJson(req, res, 200, {
          share: shareView(existing.rows[0], true),
          reused: true,
        });
        return true;
      }
      const pending = await query(
        "SELECT COUNT(*)::int AS n FROM share_invites WHERE owner_id = $1 AND status = 'pending'",
        [user.id]
      );
      if (Number(pending.rows[0]?.n || 0) >= MAX_PENDING_INVITES) {
        fail(req, res, "You have too many active invites. Revoke one first.", 429);
        return true;
      }
      const created = await query(
        "INSERT INTO share_invites (token, owner_id, email, role, status, expires_at) " +
          "VALUES ($1, $2, $3, $4, 'pending', now() + interval '7 days') RETURNING *",
        [randomBytes(24).toString("base64url"), user.id, email, role]
      );
      sendJson(req, res, 200, { share: shareView(created.rows[0], true), reused: false });
      return true;
    }
    if (method === "GET") {
      const invites = await query(
        "SELECT * FROM share_invites WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
        [user.id]
      );
      const members = await query(
        "SELECT m.user_id, m.role, m.created_at, u.display_name, u.email " +
          "FROM share_members m JOIN users u ON u.id = m.user_id " +
          "WHERE m.owner_id = $1 ORDER BY m.created_at DESC",
        [user.id]
      );
      const shared = await query(
        "SELECT m.owner_id, m.role, u.display_name FROM share_members m " +
          "JOIN users u ON u.id = m.owner_id WHERE m.user_id = $1 " +
          "ORDER BY m.created_at DESC",
        [user.id]
      );
      sendJson(req, res, 200, {
        invites: invites.rows.map(invite => shareView(invite, true)),
        members: memberViews(members.rows, user.id, user.id),
        shared_with_me: shared.rows.map(row => ({
          owner_id: String(row.owner_id),
          owner_name: row.display_name || "Someone",
          role: row.role || "viewer",
        })),
      });
      return true;
    }
  }

  if (parts.length === 3 && method === "GET") {
    const invite = await query("SELECT * FROM share_invites WHERE token = $1 LIMIT 1", [
      parts[2],
    ]);
    const row = invite.rows[0];
    if (!row) {
      fail(req, res, "This invite link is not valid.", 404);
      return true;
    }
    if (row.status === "revoked") {
      fail(req, res, "This invite has been revoked.", 410);
      return true;
    }
    if (isExpired(row.expires_at)) {
      fail(req, res, "This invite has expired.", 410);
      return true;
    }
    const owner = await query("SELECT display_name FROM users WHERE id = $1 LIMIT 1", [
      row.owner_id,
    ]);
    const count = await query(
      "SELECT COUNT(*)::int AS n FROM saved_media WHERE user_id = $1",
      [row.owner_id]
    );
    const payload: Row = {
      inviter_name: owner.rows[0]?.display_name || "Someone",
      item_count: Number(count.rows[0]?.n || 0),
      role: row.role || "viewer",
      expires_at: toIso(row.expires_at),
    };
    const viewer = user;
    if (viewer) {
      const member = await query(
        "SELECT 1 AS ok FROM share_members WHERE owner_id = $1 AND user_id = $2 LIMIT 1",
        [row.owner_id, viewer.id]
      );
      payload.already_member = Boolean(member.rowCount);
      payload.is_owner = String(row.owner_id) === String(viewer.id);
    }
    sendJson(req, res, 200, payload);
    return true;
  }

  if (parts.length === 4 && parts[3] === "accept" && method === "POST") {
    if (!user) {
      fail(req, res, "Sign in to accept this invite.");
      return true;
    }
    const invite = await query("SELECT * FROM share_invites WHERE token = $1 LIMIT 1", [
      parts[2],
    ]);
    const row = invite.rows[0];
    if (!row) {
      fail(req, res, "This invite cannot be accepted.", 400);
      return true;
    }
    if (String(row.owner_id) === String(user.id)) {
      fail(req, res, "This invite cannot be accepted.", 400);
      return true;
    }
    if (row.status === "revoked" || row.status === "accepted" || isExpired(row.expires_at)) {
      fail(req, res, "This invite cannot be accepted.", 400);
      return true;
    }
    const locked = String(row.email || "").trim().toLowerCase();
    if (locked && locked !== String(user.email || "").trim().toLowerCase()) {
      fail(req, res, "This invite cannot be accepted.", 400);
      return true;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO share_members (owner_id, user_id, role) VALUES ($1, $2, $3) " +
          "ON CONFLICT (owner_id, user_id) DO NOTHING",
        [row.owner_id, user.id, row.role || "viewer"]
      );
      await client.query(
        "UPDATE share_invites SET status = 'accepted', accepted_at = now(), " +
          "accepted_by = $1 WHERE token = $2",
        [user.id, parts[2]]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    sendJson(req, res, 200, { success: true, role: row.role || "viewer" });
    return true;
  }

  if (parts.length === 4 && parts[3] === "revoke" && method === "POST") {
    if (!user) {
      fail(req, res, "Sign in to manage sharing.");
      return true;
    }
    const revoked = await query(
      "UPDATE share_invites SET status = 'revoked' " +
        "WHERE token = $1 AND owner_id = $2 AND status = 'pending'",
      [parts[2], user.id]
    );
    if (!revoked.rowCount) {
      fail(req, res, "That invite is not active.", 404);
      return true;
    }
    sendJson(req, res, 200, { success: true });
    return true;
  }

  if (parts.length === 4 && parts[3] === "members" && method === "GET") {
    if (!user) {
      fail(req, res, "Sign in to see who you share with.");
      return true;
    }
    const invite = await query(
      "SELECT owner_id FROM share_invites WHERE token = $1 LIMIT 1",
      [parts[2]]
    );
    const ownerId = invite.rows[0]?.owner_id;
    if (!ownerId) {
      fail(req, res, "This invite link is not valid.", 404);
      return true;
    }
    if (String(ownerId) !== String(user.id)) {
      const member = await query(
        "SELECT 1 AS ok FROM share_members WHERE owner_id = $1 AND user_id = $2 LIMIT 1",
        [ownerId, user.id]
      );
      if (!member.rowCount) {
        fail(req, res, "You do not have access to this list.", 403);
        return true;
      }
    }
    const rows = await query(
      "SELECT m.user_id, m.role, m.created_at, u.display_name, u.email " +
        "FROM share_members m JOIN users u ON u.id = m.user_id " +
        "WHERE m.owner_id = $1 ORDER BY m.created_at DESC",
      [ownerId]
    );
    sendJson(req, res, 200, { members: memberViews(rows.rows, user.id, ownerId) });
    return true;
  }

  if (parts.length === 5 && parts[3] === "members" && method === "DELETE") {
    if (!user) {
      fail(req, res, "Sign in to manage sharing.");
      return true;
    }
    const invite = await query(
      "SELECT owner_id FROM share_invites WHERE token = $1 LIMIT 1",
      [parts[2]]
    );
    const ownerId = invite.rows[0]?.owner_id;
    if (!ownerId) {
      fail(req, res, "This invite link is not valid.", 404);
      return true;
    }
    if (String(ownerId) !== String(user.id)) {
      fail(req, res, "Only the owner can remove people from a shared list.", 403);
      return true;
    }
    if (!UUID_RE.test(parts[4])) {
      fail(req, res, "That person is not on this list.", 404);
      return true;
    }
    const removed = await query(
      "DELETE FROM share_members WHERE owner_id = $1 AND user_id = $2",
      [ownerId, parts[4]]
    );
    if (!removed.rowCount) {
      fail(req, res, "That person is not on this list.", 404);
      return true;
    }
    sendJson(req, res, 200, { success: true });
    return true;
  }

  return false;
}

async function handleProfiles(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  method: string
): Promise<boolean> {
  const user = await authUser(req);
  if (!user) {
    fail(req, res, "Sign in to manage profiles.");
    return true;
  }

  if (parts.length === 1 && method === "GET") {
    const profiles = await listProfiles(user.id);
    sendJson(req, res, 200, { profiles: profiles.map(serializeProfile), max: MAX_PROFILES });
    return true;
  }

  if (parts.length === 1 && method === "POST") {
    const body = bodyOf(req);
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 40) {
      fail(req, res, "Enter a name of 1 to 40 characters.", 400);
      return true;
    }
    const pin = String(body.pin ?? "");
    if (pin && !/^\d{4,8}$/.test(pin)) {
      fail(req, res, "A PIN must be 4 to 8 digits.", 400);
      return true;
    }
    const count = await countProfiles(user.id);
    if (count >= MAX_PROFILES) {
      fail(req, res, `A home can have up to ${MAX_PROFILES} profiles.`, 409);
      return true;
    }
    const salt = pin ? randomHex(16) : null;
    const created = await query(
      "INSERT INTO watch_profiles " +
        "(user_id, name, avatar, avatar_id, is_kids, is_locked, pin_hash, pin_salt, sort_order) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
      [
        user.id,
        name,
        String(body.avatar ?? "").slice(0, 400),
        String(body.avatar_id ?? "").slice(0, 40) || null,
        body.is_kids ? 1 : 0,
        pin ? 1 : 0,
        pin && salt ? hashSecret(pin, salt) : null,
        salt,
        count,
      ]
    );
    sendJson(req, res, 201, { profile: serializeProfile(created.rows[0]) });
    return true;
  }

  if (parts.length === 2 && (method === "PATCH" || method === "DELETE")) {
    const profile = await profileById(parts[1], user.id);
    if (!profile) {
      fail(req, res, "Unknown profile.", 404);
      return true;
    }
    if (method === "DELETE") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM daily_plays WHERE profile_id = $1", [parts[1]]);
        await client.query("DELETE FROM taste_events WHERE profile_id = $1", [parts[1]]);
        await client.query("DELETE FROM taste_signals WHERE profile_id = $1", [parts[1]]);
        await client.query(
          "DELETE FROM watch_history WHERE profile_id = $1 AND user_id = $2",
          [parts[1], user.id]
        );
        await client.query(
          "DELETE FROM watch_profiles WHERE id = $1 AND user_id = $2",
          [parts[1], user.id]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      sendJson(req, res, 200, { success: true });
      return true;
    }

    const body = bodyOf(req);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if ("name" in body) {
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 40) {
        fail(req, res, "Enter a name of 1 to 40 characters.", 400);
        return true;
      }
      push("name", name);
    }
    if ("avatar" in body) push("avatar", String(body.avatar ?? "").slice(0, 400));
    if ("avatar_id" in body) {
      push("avatar_id", String(body.avatar_id ?? "").slice(0, 40) || null);
    }
    if ("is_kids" in body) push("is_kids", body.is_kids ? 1 : 0);
    if ("pin" in body) {
      const pin = String(body.pin ?? "");
      if (pin && !/^\d{4,8}$/.test(pin)) {
        fail(req, res, "A PIN must be 4 to 8 digits.", 400);
        return true;
      }
      if (pin) {
        const salt = randomHex(16);
        push("pin_salt", salt);
        push("pin_hash", hashSecret(pin, salt));
        push("is_locked", 1);
      } else {
        sets.push("pin_hash = NULL", "pin_salt = NULL", "is_locked = 0");
      }
    }
    if (!sets.length) {
      sendJson(req, res, 200, { profile: serializeProfile(profile) });
      return true;
    }
    params.push(parts[1], user.id);
    const updated = await query(
      `UPDATE watch_profiles SET ${sets.join(", ")} ` +
        `WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    sendJson(req, res, 200, { profile: serializeProfile(updated.rows[0]) });
    return true;
  }

  if (parts.length === 3 && parts[2] === "unlock" && method === "POST") {
    const profile = await profileById(parts[1], user.id);
    if (!profile) {
      fail(req, res, "Unknown profile.", 404);
      return true;
    }
    if (!profile.is_locked) {
      sendJson(req, res, 200, { ok: true });
      return true;
    }
    const pin = String(bodyOf(req).pin ?? "");
    if (!verifySecret(pin, profile.pin_hash || "", profile.pin_salt || "")) {
      fail(req, res, "Incorrect PIN.", 401);
      return true;
    }
    sendJson(req, res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleAllowance(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  search: URLSearchParams,
  method: string
): Promise<boolean> {
  const user = await authUser(req);
  if (!user) {
    fail(req, res, "Sign in to see your daily allowance.");
    return true;
  }
  const profiles = await listProfiles(user.id);

  if (parts.length === 1 && method === "GET") {
    if (!profiles.length) {
      sendJson(req, res, 200, {
        allowance: {
          used: 0,
          remaining: 0,
          per_profile_cap: 0,
          account_cap: 0,
          account_used: 0,
          unlocked: false,
          unlimited: false,
          resets_at: nextUtcMidnightIso(),
          timezone: "UTC",
        },
        profiles: [],
      });
      return true;
    }
    const resolved = await resolveProfile(user, {}, search);
    if (resolved === false) {
      fail(req, res, "Unknown profile.", 403);
      return true;
    }
    const active = resolved || profiles[0];
    sendJson(req, res, 200, {
      allowance: await allowanceFor(user, active),
      profiles: await Promise.all(
        profiles.map(async profile => allowanceFor(user, profile))
      ),
    });
    return true;
  }

  if (parts.length === 2 && parts[1] === "claim" && method === "POST") {
    const body = bodyOf(req);
    const profile = await resolveProfile(user, body);
    if (profile === false) {
      fail(req, res, "Unknown profile.", 403);
      return true;
    }
    if (!profile) {
      fail(req, res, "Create a profile to start watching.", 409);
      return true;
    }
    const movieKey = String(body.movie_key ?? "").trim().slice(0, 200);
    if (!movieKey) {
      fail(req, res, "Missing a valid title.", 400);
      return true;
    }
    const day = utcToday();
    if (await hasUnlockedDay(user.id, day)) {
      await recordPlay(profile.id, day, movieKey, user.id, false);
      sendJson(req, res, 200, {
        ok: true,
        claimed: true,
        allowance: await allowanceFor(user, profile),
      });
      return true;
    }
    const claimed = await recordPlay(profile.id, day, movieKey, user.id);
    if (!claimed && !(await claimedToday(profile.id, day, movieKey))) {
      sendJson(req, res, 429, {
        error: "You have used today's free titles. Refer a friend to unlock more.",
        success: false,
        code: "daily_limit",
        allowance: await allowanceFor(user, profile),
      });
      return true;
    }
    sendJson(req, res, 200, {
      ok: true,
      claimed,
      allowance: await allowanceFor(user, profile),
    });
    return true;
  }

  return false;
}

async function handleReferrals(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  method: string
): Promise<boolean> {
  const user = await authUser(req);
  if (!user) {
    fail(req, res, "Sign in to refer friends.");
    return true;
  }

  if (parts.length === 1 && method === "GET") {
    const stats = await referralStats(user.id);
    const day = utcToday();
    sendJson(req, res, 200, {
      ...stats,
      unlocked_today: await hasUnlockedDay(user.id, day),
      unlocks_per_referral: REFERRAL_UNLOCKS_PER_ACCEPT,
      day,
    });
    return true;
  }

  if (parts.length === 2 && parts[1] === "apply" && method === "POST") {
    const code = String(bodyOf(req).code ?? "").trim().toUpperCase();
    if (!/^LM[A-Z0-9]{8}$/.test(code)) {
      fail(req, res, "That referral code is not valid.", 400);
      return true;
    }
    if (!(await acceptReferral(user.id, code))) {
      fail(req, res, "That code has already been used, or it is your own.", 409);
      return true;
    }
    const inviter = await referrerOf(user.id);
    for (const recipient of [user.id, inviter]) {
      if (!recipient) continue;
      const day = utcToday();
      for (let offset = 0; offset < REFERRAL_UNLOCKS_PER_ACCEPT; offset += 1) {
        const target = addUtcDays(day, 1 + offset);
        if (!(await hasUnlockedDay(recipient, target))) {
          await grantDay(recipient, target);
        }
      }
    }
    const stats = await referralStats(user.id);
    const day = utcToday();
    sendJson(req, res, 200, {
      success: true,
      ...stats,
      unlocked_today: await hasUnlockedDay(user.id, day),
      unlocks_per_referral: REFERRAL_UNLOCKS_PER_ACCEPT,
      day,
    });
    return true;
  }

  return false;
}

async function handleTaste(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  search: URLSearchParams,
  method: string
): Promise<boolean> {
  const user = await authUser(req);
  if (!user) {
    fail(req, res, "Sign in to use recommendations.");
    return true;
  }

  const body = bodyOf(req);
  const raw = body.profile_id ?? search.get("profile_id") ?? null;
  let profile: Row | null = null;
  if (raw == null || raw === "") {
    const profiles = await listProfiles(user.id);
    if (profiles.length === 1) profile = profiles[0];
  } else {
    profile = await profileById(String(raw), user.id);
  }

  if (parts.length === 1 && method === "POST") {
    if (!profile) {
      sendJson(req, res, 200, { ok: true, recorded: false, applied: false });
      return true;
    }
    // Taste weights are a ranking detail, not an account credential. Recording
    // is best-effort so a cold recommendation model never blocks playback.
    sendJson(req, res, 200, { ok: true, recorded: false, applied: false });
    return true;
  }

  if (parts.length === 2 && parts[1] === "state" && (method === "GET" || method === "POST")) {
    if (!profile) {
      fail(req, res, "Unknown profile.", 400);
      return true;
    }
    const events = await query(
      "SELECT COUNT(*)::int AS n FROM taste_events WHERE profile_id = $1",
      [profile.id]
    );
    sendJson(req, res, 200, {
      profile_id: String(profile.id),
      state: { genre: {}, people: {} },
      model_version: null,
      event_count: Number(events.rows[0]?.n || 0),
    });
    return true;
  }

  return false;
}

function handleRecommendations(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  method: string
): boolean {
  if (method !== "GET") return false;
  if (parts.length === 2 && parts[1] === "eval") {
    sendJson(req, res, 200, {
      samples: 0,
      hit_rate_at_5: null,
      random_hit_rate: null,
      best_possible: null,
      verdict: "insufficient_data",
      scope: "self_contained",
    });
    return true;
  }
  if (parts.length === 1) {
    sendJson(req, res, 200, { results: [], personalised: false });
    return true;
  }
  return false;
}

async function handleAdmin(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  search: URLSearchParams,
  method: string
): Promise<boolean> {
  if (!(parts.length === 2 && parts[1] === "users" && method === "GET")) return false;
  const user = await authUser(req);
  if (!user) {
    fail(req, res, "Not signed in.");
    return true;
  }
  if (!isAdminEmail(user.email)) {
    fail(req, res, "You do not have access to this page.", 403);
    return true;
  }
  const parsedLimit = Number.parseInt(search.get("limit") || "50", 10);
  const parsedOffset = Number.parseInt(search.get("offset") || "0", 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 50));
  const offset = Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0);
  const needle = `%${(search.get("q") || "").trim().slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
  const cutoff = nowIso();

  const rows = await query(
    "SELECT u.id, u.email, u.display_name, u.created_at, " +
      " (SELECT COUNT(*) FROM watch_profiles p WHERE p.user_id = u.id)::int AS profile_count, " +
      " (SELECT COUNT(*) FROM watch_history h WHERE h.user_id = u.id)::int AS history_count, " +
      " (SELECT COUNT(*) FROM saved_media m WHERE m.user_id = u.id)::int AS saved_count, " +
      " (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > $1)::int AS active_sessions, " +
      " (SELECT MAX(h.updated_at) FROM watch_history h WHERE h.user_id = u.id) AS last_active " +
      "FROM users u " +
      "WHERE LOWER(u.email) LIKE $2 ESCAPE '\\' OR LOWER(u.display_name) LIKE $2 ESCAPE '\\' " +
      "ORDER BY u.created_at DESC, u.id DESC LIMIT $3 OFFSET $4",
    [cutoff, needle, limit, offset]
  );

  const totals = await query(
    "SELECT " +
      " (SELECT COUNT(*) FROM users)::int AS users, " +
      " (SELECT COUNT(*) FROM watch_profiles)::int AS profiles, " +
      " (SELECT COUNT(*) FROM watch_history)::int AS history, " +
      " (SELECT COUNT(*) FROM saved_media)::int AS saved, " +
      " (SELECT COUNT(*) FROM sessions WHERE expires_at > $1)::int AS active_sessions",
    [cutoff]
  );

  sendJson(req, res, 200, {
    users: rows.rows.map(row => ({
      id: String(row.id),
      email: row.email,
      name: row.display_name || "",
      created_at: toIso(row.created_at),
      profile_count: Number(row.profile_count || 0),
      history_count: Number(row.history_count || 0),
      saved_count: Number(row.saved_count || 0),
      active_sessions: Number(row.active_sessions || 0),
      last_active: toIso(row.last_active),
    })),
    totals: {
      users: Number(totals.rows[0]?.users || 0),
      profiles: Number(totals.rows[0]?.profiles || 0),
      history: Number(totals.rows[0]?.history || 0),
      saved: Number(totals.rows[0]?.saved || 0),
      active_sessions: Number(totals.rows[0]?.active_sessions || 0),
    },
    limit,
    offset,
    search: search.get("q") || "",
  });
  return true;
}

async function route(
  req: HandlerRequest,
  res: HandlerResponse,
  parts: string[],
  search: URLSearchParams,
  method: string
): Promise<void> {
  if (!databaseUrl()) {
    fail(req, res, "The account service is not configured.", 503);
    return;
  }

  if (parts[0] === "auth" && (await handleAuth(req, res, parts, search, method))) return;
  if (parts[0] === "profiles" && (await handleProfiles(req, res, parts, method))) return;
  if (parts[0] === "allowance" && (await handleAllowance(req, res, parts, search, method)))
    return;
  if (parts[0] === "referrals" && (await handleReferrals(req, res, parts, method))) return;
  if (parts[0] === "taste" && (await handleTaste(req, res, parts, search, method))) return;
  if (parts[0] === "recommendations" && handleRecommendations(req, res, parts, method)) return;
  if (parts[0] === "admin" && (await handleAdmin(req, res, parts, search, method))) return;

  fail(req, res, "Not Found", 404);
}

export default async function handler(
  req: HandlerRequest,
  res: HandlerResponse
): Promise<void> {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    res.status(204);
    for (const [name, value] of Object.entries(corsHeaders(req))) {
      res.setHeader(name, value);
    }
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "https://vercel.local");
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const parts = path ? path.split("/").map(part => decodeURIComponent(part)) : [];

  try {
    await route(req, res, parts, url.searchParams, method);
  } catch (error) {
    // A driver error must never leak a connection string or SQL into a response.
    console.error("[account-api]", method, url.pathname, error);
    if (!res.headersSent) {
      fail(req, res, "The account service could not fulfil this request.", 500);
    }
  }
}
