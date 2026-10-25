import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";

import { ConnectionProvider } from "@/connection";
import { useTheme } from "@/theme";
import { useAppStateFocus } from "@/workout/queries";
import { SetQueueProvider } from "@/workout/queue/provider";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

// Server state lives in TanStack Query. The connection settings (server,
// token, profile, units) live in ConnectionProvider, backed by secure storage.
// Unsent sets live in SetQueueProvider, which wraps every screen so replay
// continues anywhere and recovery screens can show the pending count.
export default function RootLayout() {
  const theme = useTheme();
  useAppStateFocus();
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <SetQueueProvider>
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
  );
}
