import type { ReactNode } from "react";
import { View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type CardProps = {
  title: string;
  /** The value or description under the title. */
  body?: string;
  children?: ReactNode;
  testID?: string;
};

/** A surface card: a label-size title over a body line. */
export function Card({ title, body, children, testID }: CardProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radii.card,
        padding: theme.spacing.lg,
        gap: theme.spacing.xs,
      }}
    >
      <ThemedText variant="label" color="muted">
        {title}
      </ThemedText>
      {body ? <ThemedText>{body}</ThemedText> : null}
      {children}
    </View>
  );
}
