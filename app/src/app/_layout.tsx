import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { useTheme } from "@/theme";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

// Server state lives only in TanStack Query; there is no other global store.
const queryClient = new QueryClient();

export default function RootLayout() {
  const theme = useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      />
    </QueryClientProvider>
  );
}
