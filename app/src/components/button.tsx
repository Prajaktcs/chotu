import { Pressable, type StyleProp, StyleSheet, type ViewStyle } from "react-native";

import { type ColorToken, useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger";

export type ButtonProps = {
  label: string;
  /** Required: every touchable is labelled for screen readers. */
  accessibilityLabel: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const variants: Record<
  ButtonVariant,
  { background: ColorToken | null; text: ColorToken; height: "primary" | "secondary" | "text" }
> = {
  primary: { background: "primary", text: "onPrimary", height: "primary" },
  secondary: { background: "container", text: "primary", height: "secondary" },
  text: { background: null, text: "primary", height: "text" },
  danger: { background: "errorContainer", text: "error", height: "secondary" },
};

/** A full-width-capable button sized for one-handed, mid-workout taps. */
export function Button({
  label,
  accessibilityLabel,
  onPress,
  variant = "primary",
  disabled = false,
  style,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const spec = variants[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: theme.buttonHeights[spec.height],
          minWidth: theme.minTapTarget,
          borderRadius: theme.radii.panel,
          paddingHorizontal: theme.spacing.xl,
          backgroundColor: spec.background ? theme.colors[spec.background] : "transparent",
        },
        (pressed || disabled) && { opacity: disabled ? 0.5 : 0.85 },
        style,
      ]}
    >
      <ThemedText color={spec.text} medium>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
  },
});
