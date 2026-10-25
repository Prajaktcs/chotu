import type { ExpoConfig } from "expo/config";

import { version } from "./package.json";

// package.json is the single source of the app version. The client sends it
// as X-Chotu-App-Version (src/api/app-version.ts), and the server answers 426
// when it is below MIN_APP_VERSION.
const config: ExpoConfig = {
  name: "Chotu",
  slug: "chotu",
  version,
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "chotu",
  userInterfaceStyle: "automatic",
  android: {
    package: "io.github.prajaktcs.chotu",
    adaptiveIcon: {
      backgroundColor: "#F8FAF8",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: "single",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#F8FAF8",
        image: "./assets/images/splash-icon.png",
        imageWidth: 76,
        dark: { backgroundColor: "#111512" },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
