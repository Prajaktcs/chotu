import { Redirect, Stack } from "expo-router";

import { homeRoute, useConnection } from "@/connection";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** Routes that need a saved connection and a chosen profile. */
export default function MainLayout() {
  const connection = useConnection();
  if (connection.status === "loading") return null;
  if (!connection.serverUrl || !connection.profile) {
    return <Redirect href={homeRoute(connection)} />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
