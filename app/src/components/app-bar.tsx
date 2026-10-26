import { View } from "react-native";

import { useTheme } from "@/theme";

import { Button } from "./button";
import { ThemedText } from "./themed-text";

export type AppBarAction = { label: string; accessibilityLabel: string; onPress: () => void };

export type AppBarProps = { title: string; action?: AppBarAction };

/** The top bar: a title and an optional text button on the right. */
export function AppBar({ title, action }: AppBarProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: 64,
        gap: theme.spacing.sm,
      }}
    >
      <ThemedText variant="title" accessibilityRole="header">
        {title}
      </ThemedText>
      {action ? (
        <Button
          variant="text"
          label={action.label}
          accessibilityLabel={action.accessibilityLabel}
          onPress={action.onPress}
          style={{ paddingHorizontal: theme.spacing.md }}
        />
      ) : null}
    </View>
  );
}
