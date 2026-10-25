import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import { browserStore, type KeyValueStore } from "@/connection";

/**
 * Where unsent sets are kept: AsyncStorage on Android and iOS, localStorage on
 * web. Not secure storage: a queued set holds no secrets, and the queue only
 * keeps sets until they are delivered.
 */
export function queueStore(os: typeof Platform.OS = Platform.OS): KeyValueStore {
  if (os === "web") return browserStore();
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}
