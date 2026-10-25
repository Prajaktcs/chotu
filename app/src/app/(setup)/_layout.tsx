import { Stack } from "expo-router";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function SetupLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
