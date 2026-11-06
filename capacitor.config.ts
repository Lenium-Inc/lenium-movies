import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "me.streamvy.movies",
  appName: "Stream Vy",
  webDir: "dist/public",
  android: {
    allowMixedContent: true,
    backgroundColor: "#0b0c10",
    // Capacitor 5+ serves the bundle from https://localhost by default, which
    // keeps it a secure context (service workers, clipboard, share). Leave it
    // explicit so a future default change cannot silently downgrade the app.
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 700,
      backgroundColor: "#0b0c10",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0b0c10",
      overlaysWebView: false,
    },
  },
};

export default config;
