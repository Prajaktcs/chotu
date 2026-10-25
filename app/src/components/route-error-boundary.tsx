import type { ErrorBoundaryProps } from "expo-router";

import { Button } from "./button";
import { Screen } from "./screen";
import { ThemedText } from "./themed-text";

/**
 * Shared Expo Router error boundary. Every route group re-exports it:
 * `export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";`
 *
 * It never shows the error text: details stay out of the UI, so nothing
 * sensitive can leak onto the screen.
 */
export function RouteErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <Screen style={{ justifyContent: "center" }}>
      <ThemedText variant="headline" accessibilityRole="header">
        Something went wrong
      </ThemedText>
      <ThemedText color="muted">Sets already saved on this phone are kept.</ThemedText>
      <Button
        label="Try again"
        accessibilityLabel="Try again"
        onPress={() => {
          void retry();
        }}
      />
    </Screen>
  );
}
