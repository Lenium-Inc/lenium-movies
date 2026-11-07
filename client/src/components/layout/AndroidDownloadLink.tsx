import { Download } from "lucide-react";
import { ANDROID_APP_URL } from "@/lib/androidApp";
import { isNativeApp } from "@/lib/native";

/**
 * The website's download entry point for the Android build.
 *
 * Hidden inside the native app (there is nothing to install) so the same
 * component can sit in the shared nav. The APK lives on the rolling
 * `android-latest` release, whose stable filename is the reason this link does
 * not change from build to build.
 */
export function AndroidDownloadLink({
  className = "",
  showLabel = true,
}: {
  className?: string;
  showLabel?: boolean;
}) {
  if (isNativeApp()) return null;

  return (
    <a
      href={ANDROID_APP_URL}
      target="_blank"
      rel="noreferrer"
      download
      className={
        "inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2 text-sm font-semibold text-white/85 transition hover:border-white/30 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] " +
        className
      }
      aria-label="Download Stream Vy for Android"
      title="Download Stream Vy for Android"
    >
      <Download className="h-4 w-4" />
      {showLabel ? <span>Get app</span> : null}
    </a>
  );
}
