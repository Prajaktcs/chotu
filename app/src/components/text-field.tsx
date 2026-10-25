import { useId } from "react";
import { StyleSheet, TextInput, type TextInputProps, View } from "react-native";

import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

export type TextFieldProps = {
  /** Shown above the field and read by screen readers. */
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** Supporting text under the field. */
  hint?: string;
  /** Replaces the hint, in the error colour. */
  error?: string | null;
  /** Hides the value (tokens, passwords). */
  secure?: boolean;
  keyboardType?: TextInputProps["keyboardType"];
  onSubmitEditing?: () => void;
  testID?: string;
};

/** A labelled text field. Autocorrect and autocapitalise are off: it takes addresses and tokens. */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  error,
  secure = false,
  keyboardType,
  onSubmitEditing,
  testID,
}: TextFieldProps) {
  const theme = useTheme();
  const labelId = useId();
  const supporting = error ?? hint;
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <ThemedText nativeID={labelId} variant="label" color="muted" medium>
        {label}
      </ThemedText>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={labelId}
        accessibilityHint={supporting ?? undefined}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.muted}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        keyboardType={keyboardType}
        onSubmitEditing={onSubmitEditing}
        testID={testID}
        style={[
          styles.input,
          theme.typography.body,
          {
            minHeight: theme.buttonHeights.secondary,
            borderRadius: theme.radii.card,
            borderColor: error ? theme.colors.error : theme.colors.outline,
            paddingHorizontal: theme.spacing.lg,
            backgroundColor: theme.colors.surface,
            color: theme.colors.text,
          },
        ]}
      />
      {supporting ? (
        <ThemedText variant="label" color={error ? "error" : "muted"}>
          {supporting}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1 },
});
