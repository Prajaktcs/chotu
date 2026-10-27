import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppState } from "react-native";

import { ApiError } from "@/api";
import { ConnectionProvider, useConnection } from "@/connection";
import { routeForApiError } from "@/connection/error-routes";
import { useTheme } from "@/theme";
import { useAppStateFocus } from "@/workout/queries";
import { SetQueueProvider } from "@/workout/queue/provider";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

// Gestures (swipe on a set row) need GestureHandlerRootView at the root.
// Server state lives in TanStack Query. The connection settings (server,
// token, profile) live in ConnectionProvider, backed by secure storage.
// Unsent sets live in SetQueueProvider, which wraps every screen so replay
// continues anywhere and recovery screens can show the pending count.
export default function RootLayout() {
  const theme = useTheme();
  useAppStateFocus();
  const [queryClient] = useState(() => new QueryClient());
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider>
          <SetQueueProvider>
            <VersionCheck />
            <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.colors.background },
              }}
            />
          </SetQueueProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

/** Health is open even to outdated apps; check it on launch and resume. */
function VersionCheck() {
  const { deviceClient } = useConnection();
  const router = useRouter();
  useEffect(() => {
    if (!deviceClient) return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        await deviceClient.health();
      } catch (error) {
        // Connectivity failures must not prevent offline use or clear the queue.
        if (!cancelled && error instanceof ApiError && error.kind === "updateRequired") {
          const route = routeForApiError(error);
          if (route) router.replace(route);
        }
      }
    };
    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [deviceClient, router]);
  return null;
}
