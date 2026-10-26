/** An in-memory stand-in for `expo-sqlite/kv-store` (the offline set queue's store on native). */
export function createKvStoreMock() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => Promise.resolve(items.get(key) ?? null),
    setItem: (key: string, value: string) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      items.delete(key);
      return Promise.resolve();
    },
    clear: () => {
      items.clear();
      return Promise.resolve();
    },
  };
  return { __esModule: true, default: storage, Storage: storage, AsyncStorage: storage };
}
