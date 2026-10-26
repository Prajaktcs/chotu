import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { RefreshControl, ScrollView } from "react-native";

import { useTheme } from "@/theme";

import { AppBar } from "./app-bar";
import { BottomNav, type BottomNavTab } from "./bottom-nav";
import { Screen } from "./screen";

export type TabScreenProps = {
  title: string;
  tab: BottomNavTab;
  /** Pull to refresh. */
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
};

/** A read-only tab: the app bar, scrolling content with pull to refresh, the bottom navigation. */
export function TabScreen({ title, tab, refreshing, onRefresh, children }: TabScreenProps) {
  const theme = useTheme();
  const router = useRouter();
  return (
    <Screen>
      <AppBar
        title={title}
        action={{
          label: "Profile",
          accessibilityLabel: "Profile and settings",
          onPress: () => router.push("/settings"),
        }}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {children}
      </ScrollView>
      <BottomNav selected={tab} />
    </Screen>
  );
}
