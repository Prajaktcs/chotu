import { Pressable, View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type BottomNavTab = "workout";

const tabs: { id: BottomNavTab; label: string }[] = [{ id: "workout", label: "Workout" }];

export type BottomNavProps = {
  selected: BottomNavTab;
  onSelect?: (tab: BottomNavTab) => void;
};

/**
 * The bottom navigation. Phase 2 has only Workout; Tasks, Status and Plan
 * arrive with #122 and #124.
 */
export function BottomNav({ selected, onSelect }: BottomNavProps) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        justifyContent: "space-around",
        borderTopWidth: 1,
        borderTopColor: theme.colors.outline,
        paddingVertical: theme.spacing.sm,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === selected;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect?.(tab.id)}
            style={{
              minHeight: theme.minTapTarget,
              minWidth: 96,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: theme.spacing.lg,
              borderRadius: theme.radii.full,
              backgroundColor: active ? theme.colors.container : "transparent",
            }}
          >
            <ThemedText variant="label" medium color={active ? "text" : "muted"}>
              {tab.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}
