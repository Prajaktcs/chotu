// Global Jest mocks for native modules the app imports at load time.

// In-memory expo-sqlite key-value store (the offline set queue's store on native).
jest.mock("expo-sqlite/kv-store", () =>
  jest.requireActual<typeof import("./kv-store-mock")>("./kv-store-mock").createKvStoreMock(),
);

// Real UUIDv4s from the runtime's Web Crypto, so request ids are unique in tests.
jest.mock("expo-crypto", () => ({
  randomUUID: () => globalThis.crypto.randomUUID(),
}));
