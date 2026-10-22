import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "me.streamvy.movies",
  appName: "Stream Vy",
  webDir: "dist/public",
  android: {
    allowMixedContent: true,
    backgroundColor: "#09090b",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#09090b",
    },
  },
};

export default config;
