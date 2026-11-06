/**
 * The native bridge.
 *
 * The Capacitor build is still a React app in a WebView, but a plain WebView
 * is visibly "the website in a box": the status bar is styled by Android, the
 * hardware back button closes the app from any screen, and swipes have no
 * tactile response. These helpers opt into the native behaviours that make the
 * APK feel like an app rather than a bookmark, and every one of them is a
 * no-op in a browser so the same bundle still ships to Vercel.
 */

import { Capacitor } from "@capacitor/core";

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * One-time native setup. Called from `main.tsx` before the first render.
 *
 * The plugins are imported dynamically: a browser build must not pay for, or
 * fail on, native-only modules, and Vite splits them into a chunk the web
 * never requests.
 */
export async function initNative(): Promise<void> {
  if (!isNativeApp()) return;

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    if (Capacitor.getPlatform() === "android") {
      await StatusBar.setOverlaysWebView({ overlay: false });
      await StatusBar.setBackgroundColor({ color: "#0b0c10" });
    }
  } catch {
    // A device without the plugin still gets a working app.
  }

  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // Splash auto-hides on its own.
  }

  try {
    const { App } = await import("@capacitor/app");
    await App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
        return;
      }
      if (window.location.pathname !== "/") {
        window.location.assign("/");
        return;
      }
      // At the root, the Android convention is to leave/background the app,
      // not to drop the user on a black WebView.
      void App.minimizeApp();
    });
  } catch {
    // Plugin absent: Android's default back behaviour applies.
  }
}

type Impact = "light" | "medium" | "heavy";

/**
 * A tactile confirmation for gestures that otherwise have no physical feedback
 * (Vyteenda swipes, match, undo). Silent on the web.
 */
export async function tapFeedback(
  style: Impact = "light"
): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    const map = {
      light: ImpactStyle.Light,
      medium: ImpactStyle.Medium,
      heavy: ImpactStyle.Heavy,
    } as const;
    await Haptics.impact({ style: map[style] });
  } catch {
    // Haptics are an enhancement, never a requirement.
  }
}

/**
 * The platform share sheet. Returns false when there is no native sheet so the
 * caller can fall back to `navigator.share`/clipboard as it always did.
 */
export async function nativeShare(payload: {
  title?: string;
  text?: string;
  url: string;
}): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { Share } = await import("@capacitor/share");
    await Share.share({
      title: payload.title,
      text: payload.text,
      url: payload.url,
      dialogTitle: payload.title,
    });
    return true;
  } catch {
    // The user dismissing the sheet also throws. Footer: not worth a toast.
    return false;
  }
}
