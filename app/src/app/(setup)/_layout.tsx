import { Stack } from "expo-router";

import { useConnection } from "@/connection";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** Setup and the profile picker. Waits for the saved connection, so fields start from it. */
export default function SetupLayout() {
  const connection = useConnection();
  if (connection.status === "loading") return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
