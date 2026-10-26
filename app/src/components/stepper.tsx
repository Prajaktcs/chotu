import { Pressable, View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type StepperProps = {
  /** `Weight` or `Reps`. */
  label: string;
  /** The value as shown, e.g. `135 lb`. */
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
  canDecrease?: boolean;
  canIncrease?: boolean;
  testID?: string;
};

/**
 * A stepper panel: a label, a large value, and − / + buttons. Screen readers
 * get it as an adjustable control and also reach each button.
 */
export function Stepper({
  label,
  value,
  onDecrease,
  onIncrease,
  canDecrease = true,
  canIncrease = true,
  testID,
}: StepperProps) {
  const theme = useTheme();
  const name = label.toLowerCase();
  return (
    <View
      testID={testID}
      style={{
        flex: 1,
        backgroundColor: theme.colors.container,
        borderRadius: theme.radii.panel,
        padding: theme.spacing.md,
        gap: theme.spacing.xs,
      }}
    >
      <ThemedText variant="label" color="muted" medium>
        {label}
      </ThemedText>
      <ThemedText
        variant="display"
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: value }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "increment" && canIncrease) onIncrease();
          if (event.nativeEvent.actionName === "decrement" && canDecrease) onDecrease();
        }}
      >
        {value}
      </ThemedText>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <StepButton
          symbol="−"
          accessibilityLabel={`Decrease ${name}`}
          onPress={onDecrease}
          disabled={!canDecrease}
        />
        <StepButton
          symbol="+"
          accessibilityLabel={`Increase ${name}`}
          onPress={onIncrease}
          disabled={!canIncrease}
        />
      </View>
    </View>
  );
}

function StepButton({
  symbol,
  accessibilityLabel,
  onPress,
  disabled,
}: {
  symbol: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        minWidth: theme.minTapTarget,
        minHeight: theme.minTapTarget,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: theme.radii.full,
        backgroundColor: theme.colors.surface,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <ThemedText variant="title" color="primary">
        {symbol}
      </ThemedText>
    </Pressable>
  );
}
