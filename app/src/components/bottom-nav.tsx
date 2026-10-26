import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type BottomNavTab = "workout" | "tasks";

const tabs: { id: BottomNavTab; label: string }[] = [
  { id: "workout", label: "Workout" },
  { id: "tasks", label: "Tasks" },
];

export type BottomNavProps = {
  selected: BottomNavTab;
  onSelect?: (tab: BottomNavTab) => void;
};

/** Shared navigation keeps both shipped tabs reachable from every home state. */
export function BottomNav({ selected, onSelect }: BottomNavProps) {
  const router = useRouter();
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
            onPress={() => {
              if (onSelect) onSelect(tab.id);
              else if (!active) router.replace(tab.id === "tasks" ? "/tasks" : "/workout");
            }}
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
