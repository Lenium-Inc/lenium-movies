import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { Film, Loader2, Lock } from "lucide-react";
import { apiSharedSavedMedia, type SavedMediaItem } from "@/services/auth";

/**
 * Someone else's saved list, rendered read-only.
 *
 * The 403 check lives on the server, not here: this page shows whatever the
 * API returns and nothing more. Hiding the button client-side would be theatre
 * -- the list is only protected because `/api/auth/shared/<owner>/my-list`
 * verifies membership before it reads anything.
 */
export default function SharedList() {
  const [, params] = useRoute("/share/shared/:ownerId");
  const ownerId = params?.ownerId ?? "";
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; owner: string; items: SavedMediaItem[] } | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    if (!ownerId) {
      setState({ kind: "error", message: "That link is incomplete." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    apiSharedSavedMedia(ownerId)
      .then(payload => {
        if (!cancelled) {
          setState({ kind: "ready", owner: payload.owner, items: payload.items });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "This list is not available to you.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-[#050505] text-[#FFFFFF]">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        {children}
      </div>
    </div>
  );

  if (state.kind === "loading") {
    return shell(<Loader2 className="h-8 w-8 animate-spin text-white/40" />);
  }

  if (state.kind === "error") {
    return shell(
      <div className="py-16 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
          <Lock className="h-8 w-8 text-white/50" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          This list isn&apos;t shared with you
        </h1>
        <p className="mt-3 text-white/60">{state.message}</p>
        <Link
          href="/my-list"
          className="mt-8 inline-flex items-center gap-2 rounded-lg border border-white/10 px-5 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/5"
        >
          Back to My List
        </Link>
      </div>
    );
  }

  const { owner, items } = state;

  return (
    <>
      <header className="mb-8">
        <p className="text-sm text-white/40">Shared with you</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">
          {owner}&apos;s list
        </h1>
        <p className="mt-1 text-white/50">
          {items.length} title{items.length === 1 ? "" : "s"} · view only
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-12 text-center">
          <Film className="mx-auto h-12 w-12 text-white/30" />
          <p className="mt-4 text-white/50">This list is empty.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map(item => (
            <li
              key={`${item.media_type}-${item.media_id}`}
              className="flex gap-4 rounded-xl border border-white/10 bg-white/5 p-3"
            >
              <div
                className="shrink-0 overflow-hidden rounded-lg bg-white/10"
                style={{ width: 64, height: 96 }}
              >
                {item.poster_path ? (
                  <img
                    src={item.poster_path}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-white/30">
                    <Film className="h-5 w-5" />
                  </div>
                )}
              </div>
              <div className="min-w-0 py-1">
                <p className="truncate font-semibold text-white">
                  {item.title || "Untitled"}
                </p>
                <p className="mt-0.5 text-sm text-white/40">
                  {item.media_type === "tv" ? "Series" : "Movie"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-center text-sm text-white/30">
        This is a read-only view.{" "}
        <Link href="/my-list" className="text-white/60 underline">
          Back to My List
        </Link>
      </p>
    </>
  );
}
