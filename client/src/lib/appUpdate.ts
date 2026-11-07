import { ANDROID_APP_URL } from "./androidApp";
import { isNativeApp } from "./native";

/**
 * Self-update for the sideloaded Android build.
 *
 * The APK is distributed from a rolling GitHub release, not the Play Store, so
 * Android will never update it on its own. The app therefore compares its own
 * `versionCode` with a small manifest published next to the APK and offers the
 * download when a newer build exists. Installing over the top works (and keeps
 * the user's data) as long as the new APK is signed with the same key and has
 * a higher `versionCode`, which the release workflow enforces.
 */

/** Same-origin proxy that reads the manifest from the release asset. */
const VERSION_ENDPOINT = "https://www.streamvy.me/api/android-version";

export interface AndroidRelease {
  versionCode: number;
  versionName: string;
  url: string;
  notes?: string;
}

function toVersionCode(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** The build the installed app was compiled with. 0 when it cannot be read. */
export async function currentAndroidVersionCode(): Promise<number> {
  if (!isNativeApp()) return 0;
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    // On Android `build` is the versionCode; `version` is the versionName and
    // must not be parsed as one (1.42 would read as code 1).
    return toVersionCode(info.build);
  } catch {
    return 0;
  }
}

export async function fetchLatestAndroidRelease(): Promise<AndroidRelease | null> {
  try {
    const response = await fetch(VERSION_ENDPOINT, { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<AndroidRelease>;
    const versionCode = toVersionCode(data.versionCode);
    if (!versionCode) return null;
    return {
      versionCode,
      versionName:
        typeof data.versionName === "string" && data.versionName.trim()
          ? data.versionName.trim()
          : String(versionCode),
      url:
        typeof data.url === "string" && /^https?:\/\//i.test(data.url)
          ? data.url
          : ANDROID_APP_URL,
      notes: typeof data.notes === "string" ? data.notes : undefined,
    };
  } catch {
    // Offline, or the release manifest has not been published yet. Treat it as
    // "no update" rather than as an error the viewer has to dismiss.
    return null;
  }
}

/** The release to offer, or null when the installed build is current. */
export async function checkForAndroidUpdate(): Promise<AndroidRelease | null> {
  if (!isNativeApp()) return null;
  const [current, latest] = await Promise.all([
    currentAndroidVersionCode(),
    fetchLatestAndroidRelease(),
  ]);
  if (!latest || latest.versionCode <= current) return null;
  return latest;
}

/**
 * Hand the APK to the platform.
 *
 * Capacitor opens a `_system` target in the external browser, whose download
 * manager saves the file and then prompts to install it over the running app.
 */
export function openAndroidUpdate(url: string): void {
  const target = url || ANDROID_APP_URL;
  try {
    const opened = window.open(target, "_system");
    if (!opened) window.location.assign(target);
  } catch {
    window.location.assign(target);
  }
}
