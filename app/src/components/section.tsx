import type { ReactNode } from "react";
import { View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type SectionProps = {
  /** A screen-reader header. */
  title: string;
  /** A line under the title, e.g. the day's notes. */
  subtitle?: string;
  children?: ReactNode;
  testID?: string;
};

/** A surface card with a title-size header, for a screen's sections. */
export function Section({ title, subtitle, children, testID }: SectionProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radii.card,
        padding: theme.spacing.lg,
        gap: theme.spacing.sm,
      }}
    >
      <ThemedText variant="title" accessibilityRole="header">
        {title}
      </ThemedText>
      {subtitle ? <ThemedText color="muted">{subtitle}</ThemedText> : null}
      {children}
    </View>
  );
}
