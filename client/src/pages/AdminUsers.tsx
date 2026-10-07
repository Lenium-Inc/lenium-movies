import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, RefreshCw, Search, ShieldAlert, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { AuthApiError, AuthNetworkError } from "@/services/auth";
import {
  apiAdminUsers,
  type AdminTotals,
  type AdminUser,
} from "@/services/admin";

const PAGE_SIZE = 25;

/**
 * "Who has an account", for the operator.
 *
 * Read-only by design. `docs/prd.md` records the decision that catalogue
 * correction is a database edit and there is no admin surface; this page is the
 * one narrow exception -- the roster is the single operational question the
 * product cannot answer about itself -- and it deliberately offers no mutation
 * anywhere, so the exception stays that narrow.
 *
 * Every state is real: loading, empty, forbidden, offline, and failed are all
 * distinguishable on screen. None of them falls back to an empty table, because
 * an empty table is indistinguishable from "no accounts exist", which is the one
 * reading that would be wrong most of the time.
 */
export default function AdminUsers() {
  const { user, isLoading: authLoading } = useAuth();

  const [rows, setRows] = useState<AdminUser[]>([]);
  const [totals, setTotals] = useState<AdminTotals | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  /** "forbidden" is its own state because it is not retryable by waiting. */
  const [failure, setFailure] = useState<
    "forbidden" | "offline" | "error" | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);

  // The gate is server-side, so the client-side `is_admin` flag only decides
  // whether to attempt the request. When it is absent -- an older backend, or a
  // session cached before the roster existed -- the request is still made, and
  // the server's 403 is what decides. Skipping the fetch on a falsy flag would
  // mean a stale cached session could never see the roster at all.
  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    setMessage(null);
    try {
      const page = await apiAdminUsers({
        search: appliedSearch || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setRows(page.users);
      setTotals(page.totals);
    } catch (error) {
      setRows([]);
      setTotals(null);
      if (error instanceof AuthApiError && error.status === 403) {
        setFailure("forbidden");
      } else if (error instanceof AuthNetworkError) {
        // The backend is unreachable, asleep, or its CORS allowlist does not
        // include this origin. Worth naming separately: retrying on a timer
        // will not fix any of the three.
        setFailure("offline");
        setMessage(error.message);
      } else {
        setFailure("error");
        setMessage(error instanceof Error ? error.message : null);
      }
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new search starts at the first page. Without this, searching from page 3
  // lands on the empty third page of a one-page result set.
  const submitSearch = (value: string) => {
    setSearch(value);
    setOffset(0);
    setAppliedSearch(value.trim());
  };

  if (authLoading) {
    return (
      <Frame>
        <Spinner label="Checking your access…" />
      </Frame>
    );
  }

  if (!user) {
    return (
      <Frame>
        <Notice
          icon={<ShieldAlert className="h-7 w-7" aria-hidden />}
          title="Sign in to continue"
          body="The account roster is only visible to a signed-in operator."
        >
          <Link to="/login">
            <Action>Sign In</Action>
          </Link>
        </Notice>
      </Frame>
    );
  }

  // Showing this on a 403 as well as on a falsy flag, because the flag can be
  // wrong in both directions: a stale cache hides a real admin's link, and a
  // hand-edited localStorage value shows a real viewer's link. The server
  // answers the same either way.
  if (!user.is_admin && failure !== "forbidden") {
    return (
      <Frame>
        <Notice
          icon={<ShieldAlert className="h-7 w-7" aria-hidden />}
          title="No access"
          body={
            <>
              This account is not on the <code>ADMIN_EMAILS</code> allowlist, so
              the roster is not available. Add the address to that environment
              variable and restart the backend.
            </>
          }
        >
          <Link to="/">
            <Action>Back to the storefront</Action>
          </Link>
        </Notice>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="mb-6">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
              <Users className="h-6 w-6" aria-hidden />
              Accounts
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Read-only. Nothing here can change an account.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </header>

      {totals && (
        <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Accounts" value={totals.users} />
          <Stat label="Profiles" value={totals.profiles} />
          <Stat label="History rows" value={totals.history} />
          <Stat label="Saved" value={totals.saved} />
          <Stat label="Live sessions" value={totals.active_sessions} />
        </dl>
      )}

      <form
        className="mb-4 flex gap-2"
        onSubmit={event => {
          event.preventDefault();
          submitSearch(search);
        }}
        role="search"
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search by email or name"
            aria-label="Search accounts by email or name"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900/70 py-2 pl-9 pr-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-violet-500"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500"
        >
          Search
        </button>
      </form>

      {failure === "forbidden" && (
        <Notice
          icon={<ShieldAlert className="h-7 w-7" aria-hidden />}
          title="No access"
          body="This account is not on the ADMIN_EMAILS allowlist, so the roster is not available."
        />
      )}

      {failure === "offline" && (
        <Notice title="Cannot reach the backend" body={message} />
      )}

      {failure === "error" && (
        <Notice title="Could not load accounts" body={message} />
      )}

      {loading && <Spinner label="Loading accounts…" />}

      {!loading && !failure && rows.length === 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-400">
          {appliedSearch ? (
            <>
              No account matches{" "}
              <span className="text-zinc-200">{appliedSearch}</span>.
            </>
          ) : (
            "No accounts yet."
          )}
        </div>
      )}

      {!loading && !failure && rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="bg-zinc-900/70 text-xs uppercase tracking-wider text-zinc-400">
                <tr>
                  <Th>Email</Th>
                  <Th>Name</Th>
                  <Th>Joined</Th>
                  <Th align="right">Profiles</Th>
                  <Th align="right">History</Th>
                  <Th align="right">Saved</Th>
                  <Th align="right">Sessions</Th>
                  <Th>Last active</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {rows.map(row => (
                  <tr key={row.id} className="bg-zinc-950/40">
                    <td className="px-3 py-2 font-medium text-white">
                      {row.email}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{row.name}</td>
                    <td className="px-3 py-2 text-zinc-400">
                      {formatDate(row.created_at)}
                    </td>
                    <Td>{row.profile_count}</Td>
                    <Td>{row.history_count}</Td>
                    <Td>{row.saved_count}</Td>
                    <Td>{row.active_sessions}</Td>
                    <td className="px-3 py-2 text-zinc-400">
                      {row.last_active ? formatDate(row.last_active) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav className="mt-4 flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-zinc-500">
              {offset + 1}–{offset + rows.length}
              {totals ? ` of ${totals.users}` : ""}
            </span>
            <button
              type="button"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={!totals || offset + rows.length >= totals.users}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen px-4 py-10 text-[#FFFFFF] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">{children}</div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-400"
    >
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-transparent" />
      {label}
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-10 text-center">
      {icon && (
        <div className="mb-3 flex justify-center text-zinc-500">{icon}</div>
      )}
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {body && (
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-zinc-400">
          {body}
        </p>
      )}
      {children && (
        <div className="mt-5 flex justify-center gap-3">{children}</div>
      )}
    </div>
  );
}

function Action({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500">
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wider text-zinc-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-lg font-semibold text-white">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
      {children}
    </td>
  );
}

/**
 * A stored timestamp rendered in the viewer's own zone.
 *
 * `toLocaleDateString` throws a `RangeError` on an unparseable value, which
 * would blank the whole table on one bad row -- so an unreadable one is shown as
 * a dash rather than allowed to take the page down. The API normalizes these
 * already; this is the guard for the case where it did not.
 */
function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
