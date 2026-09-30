import { useState } from "react";
import { CalendarClock, Gift, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReferral } from "@/hooks/useProfiles";
import type { DailyAllowance } from "@/services/auth";

/** Midnight UTC, phrased in the viewer's own timezone where possible. */
function formatReset(resetsAt: string): string {
  const when = new Date(resetsAt);
  if (Number.isNaN(when.getTime())) return "midnight UTC";
  const local = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${local} your time (00:00 UTC)`;
}

/**
 * Shown when a profile has spent today's free titles.
 *
 * The point is to make the limit legible rather than mysterious: how many are
 * left, when it resets, and one action that changes the situation. The referral
 * code is the reason the limit is soft at all.
 */
export function DailyLimitNotice({
  allowance,
  onClose,
}: {
  allowance: DailyAllowance;
  onClose?: () => void;
}) {
  const { status, apply, refresh } = useReferral();
  const unlocked = status?.granted_days ?? 0;
  // The invited viewer needs somewhere to type the code they were sent. `apply`
  // existed and was tested but no screen ever called it, so the second half of
  // "refer a friend, you both get a day" was not reachable from the product --
  // the inviter had a share button and the invitee had nothing.
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);

  const redeem = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setApplying(true);
    setRedeemError(null);
    try {
      await apply(trimmed);
      setRedeemed(true);
      setCode("");
      await refresh();
    } catch (err) {
      setRedeemError(
        err instanceof Error ? err.message : "That code could not be applied."
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="absolute inset-0 w-full h-full object-cover opacity-25 blur-2xl" aria-hidden />
      <div className="relative z-20 w-full max-w-md rounded-xl bg-black/80 p-8 text-center text-white backdrop-blur">
        <CalendarClock className="mx-auto mb-4 h-8 w-8 text-white/70" aria-hidden />
        <h2 className="text-xl font-semibold">
          You&apos;ve watched {allowance.used} of {allowance.per_profile_cap} today
        </h2>
        <p className="mt-2 text-sm text-white/70">
          Your free titles reset at {formatReset(allowance.resets_at)}.
        </p>

        {unlocked > 0 ? (
          <p className="mt-4 text-sm text-white/80">
            You have {unlocked} unlocked day{unlocked === 1 ? "" : "s"} waiting.
            They apply to your next {unlocked === 1 ? "day" : "days"}.
          </p>
        ) : (
          <p className="mt-4 text-sm text-white/80">
            Refer a friend and you both get an unlocked day.
          </p>
        )}

        {status?.code ? (
          <div className="mt-5 rounded-lg bg-white/10 p-4">
            <p className="text-xs uppercase tracking-wide text-white/60">
              Your referral code
            </p>
            <p className="mt-1 select-all font-mono text-2xl font-semibold tracking-[0.2em]">
              {status.code}
            </p>
            <Button
              className="mt-3 w-full gap-2"
              variant="secondary"
              onClick={() => {
                const url = `${window.location.origin}/signup?ref=${status.code}`;
                if (navigator.share) {
                  void navigator
                    .share({ title: "Stream Vy", url })
                    .catch(() => {});
                } else {
                  void navigator.clipboard
                    ?.writeText(url)
                    .then(() => {
                      if (onClose) onClose();
                    })
                    .catch(() => {});
                }
              }}
            >
              <Share2 className="h-4 w-4" aria-hidden />
              Share your code
            </Button>
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-center gap-2 text-sm text-white/50">
            <Gift className="h-4 w-4" aria-hidden />
            Sign in to get a referral code.
          </div>
        )}

        {redeemed && (
          <p className="mt-3 text-sm text-emerald-300">
            Code applied &mdash; your unlocked day is queued.
          </p>
        )}

        <div className="mt-4 rounded-lg bg-white/5 p-4">
          <label
            htmlFor="redeem-referral"
            className="text-xs uppercase tracking-wide text-white/60"
          >
            Got a code from a friend?
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="redeem-referral"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void redeem();
              }}
              placeholder="LM1234ABCD"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-white/20 bg-black/40 px-3 py-2 font-mono text-sm uppercase tracking-widest text-white placeholder:text-white/30 focus:border-white/50 focus:outline-none"
            />
            <Button
              variant="secondary"
              onClick={() => void redeem()}
              disabled={applying || code.trim().length === 0}
            >
              {applying ? "Applying…" : "Apply"}
            </Button>
          </div>
          {redeemError && (
            <p className="mt-2 text-xs text-red-300">{redeemError}</p>
          )}
        </div>

        {onClose && (
          <Button className="mt-5 w-full" variant="ghost" onClick={onClose}>
            Go back
          </Button>
        )}
      </div>
    </div>
  );
}

/** Persistent reminder of what is left, shown above the player. */
export function AllowanceMeter({ allowance }: { allowance: DailyAllowance }) {
  if (allowance.unlimited) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/70">
        <Gift className="h-3.5 w-3.5" aria-hidden />
        Unlocked day &mdash; no limit today
      </div>
    );
  }
  const left = Math.max(0, allowance.remaining);
  return (
    <div className="flex items-center gap-2 text-xs text-white/70">
      <CalendarClock className="h-3.5 w-3.5" aria-hidden />
      {left} free title{left === 1 ? "" : "s"} left today
      {allowance.account_left !== undefined && allowance.account_left < allowance.per_profile_cap ? (
        <span className="text-white/40">
          ({allowance.account_left} left on the account)
        </span>
      ) : null}
    </div>
  );
}
