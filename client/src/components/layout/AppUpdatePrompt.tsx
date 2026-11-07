import { useCallback, useEffect, useState } from "react";
import { Download, Sparkles, X } from "lucide-react";
import {
  checkForAndroidUpdate,
  openAndroidUpdate,
  type AndroidRelease,
} from "@/lib/appUpdate";
import { isNativeApp } from "@/lib/native";

const DISMISSED_KEY = "streamvy:android-update-dismissed";

function readDismissed(): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.sessionStorage.getItem(DISMISSED_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeDismissed(versionCode: number): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, String(versionCode));
  } catch {
    // A blocked storage API only means the prompt can reappear next session.
  }
}

/**
 * Asks the installed Android build to update itself.
 *
 * Rendered once at the root and inert on the web. It checks on launch and
 * again whenever the app returns to the foreground, so a device that has been
 * open for days still learns about a build published in the meantime.
 */
export function AppUpdatePrompt() {
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  const check = useCallback(async () => {
    if (!isNativeApp()) return;
    const next = await checkForAndroidUpdate();
    if (!next) return;
    if (next.versionCode <= readDismissed()) return;
    setRelease(next);
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    void check();
  }, [check]);

  useEffect(() => {
    if (!isNativeApp()) return;
    let remove: (() => void) | undefined;
    void import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("resume", () => {
          void check();
        })
      )
      .then(listener => {
        remove = () => void listener.remove();
      })
      .catch(() => {
        // No App plugin: the launch check still runs.
      });
    return () => remove?.();
  }, [check]);

  if (!release || release.versionCode <= dismissed) return null;

  const dismiss = () => {
    writeDismissed(release.versionCode);
    setDismissed(release.versionCode);
    setRelease(null);
  };

  const install = () => {
    openAndroidUpdate(release.url);
    dismiss();
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[100] flex justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="false"
      aria-labelledby="android-update-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#121317]/95 shadow-[0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-xl">
        <div className="flex items-start gap-3 p-4 sm:p-5">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--brand)]/15 text-[var(--brand)]">
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="android-update-title"
              className="text-sm font-semibold text-white"
            >
              Update available
            </h2>
            <p className="mt-1 text-xs leading-5 text-white/60">
              Stream Vy {release.versionName} is ready. Installing it over this
              version keeps your list and progress.
            </p>
            {release.notes ? (
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-white/45">
                {release.notes}
              </p>
            ) : null}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={install}
                className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[var(--brand)]/90"
              >
                <Download className="h-3.5 w-3.5" />
                Update now
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="rounded-lg border border-white/10 px-3.5 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/5 hover:text-white"
              >
                Later
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss update"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
