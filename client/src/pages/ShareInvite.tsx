import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { Bookmark, CheckCircle2, Film, Loader2 } from "lucide-react";
import { useLocalSession } from "@/context/LocalSessionContext";
import { hasRemoteSession } from "@/services/lists";
import {
  apiAcceptShare,
  apiSharePreview,
  type ShareInvitePreview,
} from "@/services/auth";

type State =
  | { kind: "loading" }
  | { kind: "ready"; preview: ShareInvitePreview }
  | { kind: "error"; message: string };

/**
 * Landing page for an invite link.
 *
 * The token arrives in the URL, so this page deliberately loads no
 * third-party assets and asks the browser not to leak the referrer: a share
 * link is a bearer credential and should not end up in someone else's logs.
 */
export default function ShareInvite() {
  const [, params] = useRoute("/share/:token");
  const token = params?.token ?? "";
  const { hydrated, isAuthenticated } = useLocalSession();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    // The token is in the URL, so the browser must not send it along as a
    // Referer to anything this page links to. A meta tag is used because
    // `document.referrerPolicy` is not available on older Safari.
    if (document.querySelector('meta[name="referrer"]')) return;
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
  }, []);

  useEffect(() => {
    if (!token) {
      setState({ kind: "error", message: "This invite link is incomplete." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    apiSharePreview(token)
      .then(preview => {
        if (!cancelled) setState({ kind: "ready", preview });
      })
      .catch(err => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "This invite link is not valid.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    setAccepting(true);
    try {
      await apiAcceptShare(token);
      setState(prev =>
        prev.kind === "ready"
          ? { kind: "ready", preview: { ...prev.preview, already_member: true } }
          : prev,
      );
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "This invite cannot be accepted.",
      });
    } finally {
      setAccepting(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-[#050505] text-[#FFFFFF]">
      <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
        {children}
      </div>
    </div>
  );

  if (state.kind === "loading") {
    return shell(
      <Loader2 className="h-8 w-8 animate-spin text-white/40" />
    );
  }

  if (state.kind === "error") {
    return shell(
      <>
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
          <Film className="h-8 w-8 text-white/50" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Invite unavailable
        </h1>
        <p className="mt-3 text-white/60">{state.message}</p>
        <Link
          href="/"
          className="mt-8 inline-flex items-center gap-2 rounded-lg border border-white/10 px-5 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/5"
        >
          Browse Catalog
        </Link>
      </>
    );
  }

  const { preview } = state;

  if (preview.is_owner) {
    return shell(
      <>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          This is your own invite
        </h1>
        <p className="mt-3 text-white/60">
          You shared your own list, so there is nothing to accept.
        </p>
        <Link
          href="/my-list"
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-500"
        >
          Go to My List
        </Link>
      </>
    );
  }

  if (preview.already_member) {
    return shell(
      <>
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-white">
          You already have access
        </h1>
        <p className="mt-3 text-white/60">
          {preview.inviter_name}&apos;s list is shared with you.
        </p>
        <Link
          href="/my-list"
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-500"
        >
          <Bookmark className="h-4 w-4" />
          See shared lists
        </Link>
      </>
    );
  }

  const signedIn = hasRemoteSession();

  return shell(
    <>
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
        <Bookmark className="h-8 w-8 text-white/50" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight text-white">
        {preview.inviter_name} shared a list with you
      </h1>
      <p className="mt-3 text-white/60">
        {preview.item_count} title{preview.item_count === 1 ? "" : "s"}. You will
        be able to view them; you cannot change their list.
      </p>

      {isAuthenticated && !signedIn && (
        <p className="mt-4 text-sm text-amber-400/80">
          You are signed in locally. Sign in with an account to accept.
        </p>
      )}

      <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
        {signedIn ? (
          <button
            type="button"
            onClick={accept}
            disabled={accepting}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {accepting && <Loader2 className="h-4 w-4 animate-spin" />}
            Accept invite
          </button>
        ) : (
          <Link
            href={`/login?next=/share/${token}`}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-500"
          >
            Sign in to accept
          </Link>
        )}
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-6 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/5"
        >
          <Film className="h-4 w-4" />
          Browse Catalog
        </Link>
      </div>
    </>
  );
}
