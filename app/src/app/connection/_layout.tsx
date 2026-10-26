import { Redirect, Stack } from "expo-router";

import { useConnection } from "@/connection";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** Recovery screens work on the saved connection; without one, go to setup. */
export default function ConnectionLayout() {
  const { status, serverUrl } = useConnection();
  if (status === "loading") return null;
  if (!serverUrl) return <Redirect href="/setup" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
