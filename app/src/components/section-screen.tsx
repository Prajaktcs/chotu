import { useRouter } from "expo-router";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
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

const focus = (node: ComponentRef<typeof View> | null) => {
  if (!node) return;
  if (Platform.OS === "web") node.focus();
  else {
    const handle = findNodeHandle(node);
    if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
  }
};

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
  const menuRef = useRef<ComponentRef<typeof View>>(null);
  const closeRef = useRef<ComponentRef<typeof View>>(null);

  const close = () => {
    setDrawerOpen(false);
    requestAnimationFrame(() => focus(menuRef.current));
  };

  const [wasExpanded, setWasExpanded] = useState(expanded);
  if (expanded !== wasExpanded) {
    setWasExpanded(expanded);
    if (expanded) setDrawerOpen(false);
  }

  useEffect(() => {
    rememberScreen(screen);
  }, [screen]);

  const content = (
    <View style={{ flex: 1, gap: theme.spacing.lg }}>
      <AppBar
        title={section.label}
        menuRef={menuRef}
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

  return (
    <Screen>
      {content}
      <Modal
        testID="section-navigation"
        visible={drawerOpen}
        transparent
        animationType="fade"
        onRequestClose={close}
        onShow={() => focus(closeRef.current)}
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
                  ref={closeRef}
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
