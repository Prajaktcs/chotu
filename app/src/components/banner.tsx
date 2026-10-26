import { View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type BannerProps = {
  tone: "pending" | "error";
  title: string;
  body: string;
  testID?: string;
};

/**
 * A status banner in pending or error colours. The text carries the meaning
 * on its own; the colour only reinforces it.
 */
export function Banner({ tone, title, body, testID }: BannerProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${title}. ${body}`}
      style={{
        backgroundColor: theme.colors[tone === "pending" ? "pendingContainer" : "errorContainer"],
        borderRadius: theme.radii.card,
        padding: theme.spacing.lg,
        gap: theme.spacing.xs,
      }}
    >
      <ThemedText color={tone} medium>
        {title}
      </ThemedText>
      <ThemedText color={tone} variant="label">
        {body}
      </ThemedText>
    </View>
  );
}
