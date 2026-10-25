import Constants from "expo-constants";

/**
 * This build's version, sent as `X-Chotu-App-Version`. app.config.ts reads it
 * from package.json, the single source of truth. A build without one reports
 * 0.0.0, which the server answers with 426 rather than guessing.
 */
export const APP_VERSION: string = Constants.expoConfig?.version ?? "0.0.0";
