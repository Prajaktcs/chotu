// Global Jest mocks for native modules the app imports at load time.

// In-memory AsyncStorage (the offline set queue's store on native).
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual<{ default: unknown }>(
    "@react-native-async-storage/async-storage/jest/async-storage-mock",
  ),
);

// Real UUIDv4s from the runtime's Web Crypto, so request ids are unique in tests.
jest.mock("expo-crypto", () => ({
  randomUUID: () => globalThis.crypto.randomUUID(),
}));
