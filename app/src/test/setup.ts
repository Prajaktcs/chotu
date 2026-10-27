import type * as ReactNative from "react-native";

import type * as ExerciseVideoMock from "./exercise-video-mock";

// Global Jest mocks for native modules the app imports at load time.

jest.mock("expo-constants", () => ({
  ...jest.requireActual("expo-constants"),
  __esModule: true,
  default: {
    ...jest.requireActual("expo-constants").default,
    expoConfig: { version: jest.requireActual("../../package.json").version },
  },
}));

// In-memory expo-sqlite key-value store (the offline set queue's store on native).
jest.mock("expo-sqlite/kv-store", () =>
  jest.requireActual<typeof import("./kv-store-mock")>("./kv-store-mock").createKvStoreMock(),
);

// Real UUIDv4s from the runtime's Web Crypto, so request ids are unique in tests.
jest.mock("expo-crypto", () => ({
  randomUUID: () => globalThis.crypto.randomUUID(),
}));

// Gesture handler's native module is mocked by its jestSetup (package.json).
// The swipeable row is a plain View that keeps its props, so a test fires
// `swipeableOpen` on it (Reanimated's worklets don't run under Jest).
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () =>
  jest.requireActual<typeof import("./swipeable-mock")>("./swipeable-mock"),
);

// Decoder and image lifecycle are tested without native rendering/decoding.
jest.mock("expo-video", () =>
  jest.requireActual<typeof ExerciseVideoMock>("./exercise-video-mock"),
);
jest.mock("expo-image", () => ({
  Image: jest.requireActual<typeof ReactNative>("react-native").View,
}));
