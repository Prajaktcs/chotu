/** An in-memory expo-secure-store for Jest. Use with:
 *
 *   jest.mock("expo-secure-store", () =>
 *     jest.requireActual<typeof import("@/test/secure-store-mock")>("@/test/secure-store-mock")
 *       .createSecureStoreMock(),
 *   );
 */
export type SecureStoreMock = {
  items: Map<string, string>;
  getItemAsync: jest.Mock<Promise<string | null>, [string]>;
  setItemAsync: jest.Mock<Promise<void>, [string, string]>;
  deleteItemAsync: jest.Mock<Promise<void>, [string]>;
  reset(): void;
};

export function createSecureStoreMock(): SecureStoreMock {
  const items = new Map<string, string>();
  return {
    items,
    getItemAsync: jest.fn((key: string) => Promise.resolve(items.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      items.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      items.delete(key);
      return Promise.resolve();
    }),
    reset() {
      items.clear();
    },
  };
}
