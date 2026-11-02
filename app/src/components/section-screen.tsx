import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { rememberScreen, type ScreenId, sectionOf } from "@/navigation/sections";
import { useTheme } from "@/theme";

import { AppBar } from "./app-bar";
import { Button } from "./button";
import { Screen } from "./screen";
import { SectionList, SectionTabs } from "./section-nav";
import { ThemedText } from "./themed-text";

/** Material's expanded width class: the sidebar stays visible from here up. */
export const EXPANDED_WIDTH = 840;

export type SectionScreenProps = {
  screen: ScreenId;
  children: ReactNode;
};

/**
 * A section home screen: the app bar, the section's four tabs and the content.
 * Phones open sections from a drawer; expanded layouts keep a sidebar.
 */
export function SectionScreen({ screen, children }: SectionScreenProps) {
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const expanded = width >= EXPANDED_WIDTH;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const section = sectionOf(screen);

  useEffect(() => {
    rememberScreen(screen);
  }, [screen]);

  const content = (
    <View style={{ flex: 1, gap: theme.spacing.lg }}>
      <AppBar
        title={section.label}
        onMenu={expanded ? undefined : () => setDrawerOpen(true)}
        action={{
          label: "Profile",
          accessibilityLabel: "Profile and settings",
          onPress: () => router.push("/settings"),
        }}
      />
      <SectionTabs screen={screen} />
      {children}
    </View>
  );

  if (expanded) {
    return (
      <Screen style={{ flexDirection: "row", gap: theme.spacing.xl }}>
        <ScrollView
          accessibilityLabel="Sections"
          style={{ width: 280, flexGrow: 0 }}
          contentContainerStyle={{ paddingVertical: theme.spacing.lg, gap: theme.spacing.sm }}
        >
          <ThemedText variant="headline">Chotu</ThemedText>
          <SectionList screen={screen} />
        </ScrollView>
        {content}
      </Screen>
    );
  }

  const close = () => setDrawerOpen(false);
  return (
    <Screen>
      {content}
      <Modal
        visible={drawerOpen}
        transparent
        animationType="fade"
        onRequestClose={close}
        accessibilityViewIsModal
      >
        <View style={{ flex: 1, flexDirection: "row" }}>
          <SafeAreaView
            style={{
              width: Math.min(320, width * 0.85),
              backgroundColor: theme.colors.surface,
              paddingHorizontal: theme.spacing.lg,
            }}
          >
            <ScrollView
              accessibilityLabel="Sections"
              contentContainerStyle={{ paddingVertical: theme.spacing.lg, gap: theme.spacing.sm }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <ThemedText variant="headline" accessibilityRole="header">
                  Chotu
                </ThemedText>
                <Button
                  variant="text"
                  label="Close"
                  accessibilityLabel="Close section navigation"
                  onPress={close}
                  style={{ paddingHorizontal: theme.spacing.md }}
                />
              </View>
              <SectionList screen={screen} onNavigate={close} />
            </ScrollView>
          </SafeAreaView>
          {/* Tapping outside closes; screen readers use Close or Back instead. */}
          <Pressable
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            onPress={close}
            style={{ flex: 1, backgroundColor: "rgba(0, 0, 0, 0.4)" }}
          />
        </View>
      </Modal>
    </Screen>
  );
}
