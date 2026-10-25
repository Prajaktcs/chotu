import config from "../../app.config";
import { version } from "../../package.json";
import { APP_VERSION } from "./app-version";

// Hoisted above the imports, so app-version reads this app config.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { version: "1.2.3" } },
}));

describe("app version", () => {
  it("is package.json's version in the app config", () => {
    expect(config.version).toBe(version);
    expect(version).toBe("0.1.0");
  });

  it("is read from the app config at runtime", () => {
    expect(APP_VERSION).toBe("1.2.3");
  });
});
