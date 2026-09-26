import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Trash2, UserPlus, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  apiCreateShare,
  apiRemoveShareMember,
  apiRevokeShare,
  apiShares,
  type ShareInvite,
  type ShareMember,
} from "@/services/auth";

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

function expiresIn(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  return "less than an hour left";
}

/**
 * Owner-side sharing controls: mint an invite, copy the link, and see who has
 * redeemed it. Everything here is read-only with respect to the list itself --
 * members can see the owner's saved titles, never edit them.
 *
 * Only accounts with a server session can share. The local demo profile has no
 * backend user, so the button is hidden rather than shown-and-failing.
 */
export function ShareListDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [invites, setInvites] = useState<ShareInvite[]>([]);
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const payload = await apiShares();
      setInvites(payload.invites);
      setMembers(payload.members);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sharing.");
    }
  }, []);

  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    void refresh();
  }, [open, loaded, refresh]);

  // An invite is a bearer credential, so the panel must not keep rendering it
  // in the DOM once closed.
  useEffect(() => {
    if (!open) {
      setCopied(null);
      setError(null);
    }
  }, [open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { share } = await apiCreateShare({ email: email.trim() || null });
      setEmail("");
      await refresh();
      await copy(share.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create an invite.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (token: string) => {
    const url = shareUrl(token);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Clipboard API needs a secure context; plain http dev servers fall
        // back to a selectable field rather than failing silently.
        window.prompt("Copy this invite link:", url);
      }
      setCopied(token);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt("Copy this invite link:", url);
    }
  };

  const revoke = async (token: string) => {
    setBusy(true);
    try {
      await apiRevokeShare(token);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke that invite.");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (token: string, userId: string) => {
    setBusy(true);
    try {
      await apiRemoveShareMember(token, userId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that person.");
    } finally {
      setBusy(false);
    }
  };

  // The most recent live invite is the one worth offering to copy; accepted and
  // revoked ones are history, not links to hand out.
  const activeInvite = invites.find(i => i.status === "pending");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share your list</DialogTitle>
          <DialogDescription>
            Anyone with an invite link can view the titles in your list. They
            cannot add, remove or reorder anything.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="their@email.com (optional)"
              aria-label="Email address to lock the invite to"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              <UserPlus className="h-4 w-4" />
              Create
            </button>
          </div>

          <p className="-mt-3 text-xs text-white/40">
            Adding an address locks the link to that account. Leave it blank for
            an open link anyone can use.
          </p>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {activeInvite && (
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="flex items-center gap-2 text-sm text-white/80">
                <Link2 className="h-4 w-4 shrink-0 text-white/40" />
                <span className="truncate font-mono text-xs">
                  {shareUrl(activeInvite.token)}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-white/40">
                  {activeInvite.email
                    ? `Locked to ${activeInvite.email}`
                    : "Open link"}{" "}
                  · {expiresIn(activeInvite.expires_at)}
                </span>
                <button
                  type="button"
                  onClick={() => copy(activeInvite.token)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/80 transition hover:bg-white/5"
                >
                  {copied === activeInvite.token ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {invites.filter(i => i.status === "pending").length > 1 && (
            <ul className="space-y-1.5">
              {invites
                .filter(i => i.status === "pending")
                .map(invite => (
                  <li
                    key={invite.token}
                    className="flex items-center justify-between gap-2 text-xs text-white/50"
                  >
                    <span className="truncate">
                      {invite.email || "Open link"} ·{" "}
                      {expiresIn(invite.expires_at)}
                    </span>
                    <button
                      type="button"
                      onClick={() => revoke(invite.token)}
                      disabled={busy}
                      className="shrink-0 text-white/40 transition hover:text-red-400 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
            </ul>
          )}

          {members.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white/80">
                <Users className="h-4 w-4 text-white/40" />
                People with access ({members.length})
              </div>
              <ul className="space-y-1.5">
                {members.map(member => (
                  <li
                    key={member.user_id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-white/80">
                      {member.display_name}
                      {member.email && (
                        <span className="ml-2 text-xs text-white/40">
                          {member.email}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const token =
                          activeInvite?.token ??
                          invites.find(i => i.status === "accepted")?.token;
                        if (token) void removeMember(token, member.user_id);
                      }}
                      disabled={busy}
                      aria-label={`Remove ${member.display_name}`}
                      className="shrink-0 text-white/40 transition hover:text-red-400 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
