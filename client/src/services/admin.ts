/**
 * Client for the backend account roster (`/api/admin/users`).
 *
 * Read-only. The endpoint exists to answer "who has an account", which nothing
 * in the product can answer about itself, and it writes nothing: there is no
 * catalogue-correction surface, no role management, and no way to change an
 * account from here. See `docs/prd.md` on the no-admin-surface decision that
 * this deliberately leaves closed.
 *
 * Authorization is decided server-side on every request, against the
 * `ADMIN_EMAILS` allowlist. The `is_admin` flag on the signed-in user is only
 * used to decide whether to *show* the link, so a stale or hand-edited
 * localStorage value cannot reach the data.
 */
import { request } from "@/services/auth";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  /** ISO instant the account was created, or null if the driver gave none. */
  created_at: string | null;
  profile_count: number;
  history_count: number;
  saved_count: number;
  /** Sessions whose 30-day expiry has not passed. */
  active_sessions: number;
  /** Most recent watch-history write for this account, or null if never. */
  last_active: string | null;
}

export interface AdminTotals {
  users: number;
  profiles: number;
  history: number;
  saved: number;
  active_sessions: number;
}

export interface AdminUserPage {
  users: AdminUser[];
  /** Whole-database counts, independent of `search` and of the current page. */
  totals: AdminTotals;
  limit: number;
  offset: number;
  search: string;
}

/**
 * Thrown when a signed-in account is not on the admin allowlist.
 *
 * Not a bespoke error type: `request` already raises `AuthApiError` carrying
 * the status, so callers branch on `status === 403`. Worth stating here because
 * the two rejections mean different things and are handled differently -- a 403
 * means "sign in as someone else" and the token is still valid, whereas a 401
 * has already cleared the session in the shared request wrapper.
 */

export async function apiAdminUsers(
  input: {
    search?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<AdminUserPage> {
  const params = new URLSearchParams();
  if (input.search) params.set("q", input.search);
  if (input.limit) params.set("limit", String(input.limit));
  if (input.offset) params.set("offset", String(input.offset));
  const query = params.toString();

  const page = await request<AdminUserPage>(
    `/api/admin/users${query ? `?${query}` : ""}`,
    { auth: true }
  );
  return page;
}
