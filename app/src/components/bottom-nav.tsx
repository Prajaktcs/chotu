import { type Href, useRouter } from "expo-router";
import { Pressable, View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type BottomNavTab = "workout" | "plan" | "status" | "tasks";

const tabs: { id: BottomNavTab; label: string; href: Href }[] = [
  { id: "workout", label: "Workout", href: "/workout" },
  { id: "plan", label: "Plan", href: "/plan" },
  { id: "status", label: "Status", href: "/status" },
  { id: "tasks", label: "Tasks", href: "/tasks" },
];

export type BottomNavProps = {
  selected: BottomNavTab;
  onSelect?: (tab: BottomNavTab) => void;
};

/** Shared navigation keeps every tab reachable from every home state. */
export function BottomNav({ selected, onSelect }: BottomNavProps) {
  const router = useRouter();
  const theme = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        gap: theme.spacing.xs,
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
            aria-selected={active}
            onPress={() => {
              if (onSelect) onSelect(tab.id);
              else if (!active) router.replace(tab.href);
            }}
            style={{
              flex: 1,
              minHeight: theme.minTapTarget,
              minWidth: theme.minTapTarget,
              alignItems: "center",
              justifyContent: "center",
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
