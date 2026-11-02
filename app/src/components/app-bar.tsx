import { Pressable, View } from "react-native";

import { useTheme } from "@/theme";

import { Button } from "./button";
import { ThemedText } from "./themed-text";

export type AppBarAction = { label: string; accessibilityLabel: string; onPress: () => void };

export type AppBarProps = {
  title: string;
  action?: AppBarAction;
  /** Shows the menu button that opens section navigation (phone layouts). */
  onMenu?: () => void;
};

/** The top bar: an optional menu button, a title and an optional text button on the right. */
export function AppBar({ title, action, onMenu }: AppBarProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 64,
        gap: theme.spacing.sm,
      }}
    >
      {onMenu ? <MenuButton onPress={onMenu} /> : null}
      <ThemedText variant="title" accessibilityRole="header" style={{ flex: 1 }}>
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

/** Three bars drawn with views, so no icon font is needed. */
function MenuButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open section navigation"
      onPress={onPress}
      style={({ pressed }) => ({
        width: theme.minTapTarget,
        height: theme.minTapTarget,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        marginLeft: -theme.spacing.md,
        borderRadius: theme.radii.full,
        backgroundColor: pressed ? theme.colors.container : "transparent",
      })}
    >
      {[0, 1, 2].map((bar) => (
        <View
          key={bar}
          style={{ width: 20, height: 2, borderRadius: 1, backgroundColor: theme.colors.text }}
        />
      ))}
    </Pressable>
  );
}
