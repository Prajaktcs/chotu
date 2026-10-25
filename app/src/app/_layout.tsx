import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";

import { ConnectionProvider } from "@/connection";
import { useTheme } from "@/theme";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

// Server state lives in TanStack Query. The connection settings (server,
// token, profile, units) live in ConnectionProvider, backed by secure storage.
export default function RootLayout() {
  const theme = useTheme();
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.background },
          }}
        />
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
