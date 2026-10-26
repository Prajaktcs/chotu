import { act, renderHook } from "@testing-library/react-native";

import { usePullToRefresh } from "./pull-to-refresh";

function deferred() {
  const holder: { resolve?: () => void; reject?: (error: Error) => void } = {};
  const promise = new Promise<void>((resolve, reject) => {
    holder.resolve = resolve;
    holder.reject = reject;
  });
  return { promise, resolve: () => holder.resolve?.(), reject: (e: Error) => holder.reject?.(e) };
}

it("spins only for the user's pull, until its refresh settles", async () => {
  let pending = deferred();
  const { result } = await renderHook(() => usePullToRefresh(() => pending.promise));
  // A background refetch never calls onRefresh: no spinner.
  expect(result.current.refreshing).toBe(false);

  await act(async () => result.current.onRefresh());
  expect(result.current.refreshing).toBe(true);
  await act(async () => pending.resolve());
  expect(result.current.refreshing).toBe(false);

  pending = deferred();
  await act(async () => result.current.onRefresh());
  expect(result.current.refreshing).toBe(true);
  await act(async () => pending.reject(new Error("offline")));
  expect(result.current.refreshing).toBe(false);
});
