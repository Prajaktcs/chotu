import { addReleaseSigning, SIGNING_ENV } from "./with-release-signing.ts";

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe("addReleaseSigning", () => {
  it("signs release builds with the release config and leaves debug alone", () => {
    const result = addReleaseSigning(TEMPLATE);

    expect(result).toMatch(/release \{[^}]*?\n\s*signingConfig signingConfigs\.release/);
    expect(result).toMatch(/debug \{\n\s*signingConfig signingConfigs\.debug/);
    expect(result.match(/signingConfigs\.debug/g)).toHaveLength(1);
  });

  it("reads every secret from the environment and writes none into the file", () => {
    const result = addReleaseSigning(TEMPLATE);

    for (const name of SIGNING_ENV) {
      expect(result).toContain(`System.getenv("${name}")`);
    }
    expect(result).toContain("throw new GradleException");
  });

  it("is idempotent across repeated prebuilds", () => {
    const once = addReleaseSigning(TEMPLATE);

    expect(addReleaseSigning(once)).toBe(once);
  });

  it("fails loudly when the template changes shape", () => {
    expect(() => addReleaseSigning("android {}\n")).toThrow(/expected template/);
  });
});
