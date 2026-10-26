import Storage from "expo-sqlite/kv-store";

import type { KeyValueStore } from "@/connection";

/**
 * Where unsent sets are kept on Android and iOS: expo-sqlite's key-value
 * store. Not secure storage: a queued set holds no secrets, and the queue
 * only keeps sets until they are delivered. Web uses `storage.ts`.
 */
export function queueStore(): KeyValueStore {
  return {
    getItem: (key) => Storage.getItem(key),
    setItem: (key, value) => Storage.setItem(key, value),
    removeItem: (key) => Storage.removeItem(key),
  };
}
