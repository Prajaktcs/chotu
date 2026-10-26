import { ActivityIndicator, View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

/** A spinner with a visible, spoken label. */
export function Progress({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ alignItems: "center", gap: theme.spacing.sm, paddingVertical: theme.spacing.xl }}
    >
      <ActivityIndicator color={theme.colors.primary} />
      <ThemedText color="muted">{label}</ThemedText>
    </View>
  );
}
