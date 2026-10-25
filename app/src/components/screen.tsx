import type { ReactNode } from "react";
import { ScrollView, type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "@/theme";

export type ScreenProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Scrolls the content (forms and long pages), so it stays reachable on
   * small screens and above the keyboard.
   */
  scroll?: boolean;
};

/** A safe-area screen on the theme background with the standard side padding. */
export function Screen({ children, style, scroll = false }: ScreenProps) {
  const theme = useTheme();
  const layout = {
    paddingHorizontal: theme.spacing.screen,
    gap: theme.spacing.lg,
  };
  if (scroll) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.scrollContent,
            layout,
            { paddingVertical: theme.spacing.xl },
            style,
          ]}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: theme.colors.background }, layout, style]}
    >
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { flexGrow: 1 },
});
