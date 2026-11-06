/**
 * Where the Android build is published.
 *
 * The APK workflow refreshes the `android-latest` release on every push to
 * main with a fixed asset name (`streamvy-android.apk`), so this URL is stable
 * across builds. Keeping it in one module means the profile menu, the My List
 * gate and any future landing page cannot disagree about where the app lives.
 */
export const ANDROID_APP_URL =
  "https://github.com/Lenium-Inc/lenium-movies/releases/download/android-latest/streamvy-android.apk";
