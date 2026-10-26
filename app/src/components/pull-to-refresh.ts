import { useState } from "react";

/**
 * Pull to refresh that spins only for the user's pull, not for background
 * refetches (focus, reconnect, invalidation), until `refresh` settles.
 */
export function usePullToRefresh(refresh: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    void refresh()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };
  return { refreshing, onRefresh };
}
