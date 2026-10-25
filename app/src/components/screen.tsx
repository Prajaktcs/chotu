import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "@/theme";

export type ScreenProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** A safe-area screen on the theme background with the standard side padding. */
export function Screen({ children, style }: ScreenProps) {
  const theme = useTheme();
  return (
    <SafeAreaView
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.background,
          paddingHorizontal: theme.spacing.screen,
          gap: theme.spacing.lg,
        },
        style,
      ]}
    >
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
