import type { ReactNode } from "react";
import { RefreshControl, ScrollView } from "react-native";

import type { ScreenId } from "@/navigation/sections";
import { useTheme } from "@/theme";

import { usePullToRefresh } from "./pull-to-refresh";
import { SectionScreen } from "./section-screen";

export type TabScreenProps = {
  screen: ScreenId;
  /** Pull to refresh; the spinner shows until it settles (not for background refetches). */
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
};

/** A section screen whose content scrolls, with pull to refresh. */
export function TabScreen({ screen, onRefresh, children }: TabScreenProps) {
  const theme = useTheme();
  const pull = usePullToRefresh(onRefresh);
  return (
    <SectionScreen screen={screen}>
      <ScrollView
        testID={`${screen}-scroll`}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.lg }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {children}
      </ScrollView>
    </SectionScreen>
  );
}
