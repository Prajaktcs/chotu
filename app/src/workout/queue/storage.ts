import { browserStore, type KeyValueStore } from "@/connection";

/**
 * Where unsent sets are kept on web: localStorage. Android and iOS use
 * expo-sqlite's key-value store (`storage.native.ts`); its web build needs a
 * WebAssembly worker, which the web build doesn't carry.
 */
export function queueStore(): KeyValueStore {
  return browserStore();
}
