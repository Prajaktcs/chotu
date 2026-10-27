import * as SecureStore from "expo-secure-store";

import type { SecureStoreMock } from "@/test/secure-store-mock";

import {
  browserStore,
  clearConnection,
  loadConnection,
  platformStore,
  saveConnection,
  SETTINGS_KEY,
  secureStore,
  type StoredConnection,
  TOKEN_KEY,
} from "./storage";

jest.mock("expo-secure-store", () =>
  jest
    .requireActual<typeof import("@/test/secure-store-mock")>("@/test/secure-store-mock")
    .createSecureStoreMock(),
);

const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

const TOKEN = "alex_phone.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const connection: StoredConnection = {
  serverUrl: "https://mini.ts.net:8787",
  token: TOKEN,
  profile: { id: "alex", name: "Alex", weight_unit: "kg" },
};

/** A localStorage stand-in. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

beforeEach(() => {
  secure.reset();
  jest.clearAllMocks();
});

describe("secure store (native)", () => {
  it("round-trips a connection through expo-secure-store", async () => {
    await saveConnection(secureStore, connection);

    await expect(loadConnection(secureStore)).resolves.toEqual(connection);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(TOKEN_KEY, TOKEN);
  });

  it("keeps the token out of the settings entry", async () => {
    await saveConnection(secureStore, connection);

    expect(secure.items.get(SETTINGS_KEY)).not.toContain(TOKEN);
    expect(JSON.parse(secure.items.get(SETTINGS_KEY) ?? "")).toEqual({
      version: 1,
      serverUrl: "https://mini.ts.net:8787",
      profile: { id: "alex", name: "Alex", weight_unit: "kg" },
    });
  });

  it("is empty on a fresh install", async () => {
    await expect(loadConnection(secureStore)).resolves.toBeNull();
  });

  it("clears both entries", async () => {
    await saveConnection(secureStore, connection);
    await clearConnection(secureStore);

    expect(secure.items.size).toBe(0);
    await expect(loadConnection(secureStore)).resolves.toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, serverUrl: "https://x" })],
    ["no server", JSON.stringify({ version: 1 })],
  ])("treats %s settings as no connection", async (_, raw) => {
    secure.items.set(TOKEN_KEY, TOKEN);
    secure.items.set(SETTINGS_KEY, raw);

    await expect(loadConnection(secureStore)).resolves.toBeNull();
  });

  it("drops a malformed profile and unknown units", async () => {
    secure.items.set(TOKEN_KEY, TOKEN);
    secure.items.set(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        serverUrl: "https://mini.ts.net:8787",
        profile: { id: 3 },
        units: { alex: "stone", jordan: "kg" },
      }),
    );

    await expect(loadConnection(secureStore)).resolves.toEqual({
      serverUrl: "https://mini.ts.net:8787",
      token: TOKEN,
      profile: null,
    });
  });

  it("preserves an unknown legacy unit and ignores obsolete phone preferences", async () => {
    secure.items.set(TOKEN_KEY, TOKEN);
    secure.items.set(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        serverUrl: connection.serverUrl,
        profile: { id: "alex", name: "Alex" },
        units: { alex: "kg" },
      }),
    );
    await expect(loadConnection(secureStore)).resolves.toEqual({
      ...connection,
      profile: { id: "alex", name: "Alex", weight_unit: undefined },
    });
  });
});

describe("browser store (web)", () => {
  it("round-trips a connection through localStorage", async () => {
    const storage = memoryStorage();
    const store = browserStore(storage);

    await saveConnection(store, connection);

    expect(storage.items.get(TOKEN_KEY)).toBe(TOKEN);
    await expect(loadConnection(store)).resolves.toEqual(connection);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("works without localStorage", async () => {
    const store = browserStore(null);

    await saveConnection(store, connection);

    await expect(loadConnection(store)).resolves.toBeNull();
  });

  it("rejects instead of throwing when the browser blocks storage", async () => {
    const blocked = new Error("The operation is insecure.");
    const store = browserStore({
      getItem: () => {
        throw blocked;
      },
      setItem: () => {
        throw blocked;
      },
      removeItem: () => {
        throw blocked;
      },
    });

    // Each call returns a promise, so callers handle one failure path.
    const calls = [store.getItem("k"), store.setItem("k", "v"), store.removeItem("k")];
    await Promise.all(calls.map((call) => expect(call).rejects.toBe(blocked)));
  });

  it("rejects when accessing localStorage itself is blocked", async () => {
    const blocked = new Error("Storage access denied");
    // Jest's contextified global swallows accessor exceptions on the global
    // itself. A proxy models the browser's throwing storage getter faithfully.
    const runtime = globalThis;
    const original = Object.getOwnPropertyDescriptor(runtime, "globalThis");
    Object.defineProperty(runtime, "globalThis", {
      configurable: true,
      value: new Proxy(runtime, {
        get: (target, key, receiver) => {
          if (key === "localStorage") throw blocked;
          return Reflect.get(target, key, receiver);
        },
      }),
    });
    try {
      const store = browserStore();
      await expect(store.getItem("k")).rejects.toBe(blocked);
      await expect(store.setItem("k", "v")).rejects.toBe(blocked);
      await expect(store.removeItem("k")).rejects.toBe(blocked);
    } finally {
      if (original) Object.defineProperty(runtime, "globalThis", original);
    }
  });

  it("is the store platformStore picks on web", async () => {
    const storage = memoryStorage();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    try {
      await saveConnection(platformStore("web"), connection);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }

    expect(storage.items.get(TOKEN_KEY)).toBe(TOKEN);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("uses secure storage on Android", () => {
    expect(platformStore("android")).toBe(secureStore);
  });
});
