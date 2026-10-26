import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { RefreshControl, ScrollView } from "react-native";

import { useTheme } from "@/theme";

import { AppBar } from "./app-bar";
import { BottomNav, type BottomNavTab } from "./bottom-nav";
import { usePullToRefresh } from "./pull-to-refresh";
import { Screen } from "./screen";

export type TabScreenProps = {
  title: string;
  tab: BottomNavTab;
  /** Pull to refresh; the spinner shows until it settles (not for background refetches). */
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
};

/** A read-only tab: the app bar, scrolling content with pull to refresh, the bottom navigation. */
export function TabScreen({ title, tab, onRefresh, children }: TabScreenProps) {
  const theme = useTheme();
  const router = useRouter();
  const pull = usePullToRefresh(onRefresh);
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
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {children}
      </ScrollView>
      <BottomNav selected={tab} />
    </Screen>
  );
}
