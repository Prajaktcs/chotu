import { Button } from "./button";
import { Card } from "./card";
import { ThemedText } from "./themed-text";

export type LoadFailedProps = {
  /** What didn't load, e.g. `your tasks`. */
  what: string;
  /** Names the retry for screen readers, e.g. `tasks`. */
  noun: string;
  /** A message safe to show (`messageForError`). */
  message: string;
  /** Shown when the last loaded data stays on screen. */
  keptNote?: string;
  onRetry: () => void;
};

/** A failed load, announced as an alert, with Retry. */
export function LoadFailed({ what, noun, message, keptNote, onRetry }: LoadFailedProps) {
  return (
    <Card title="Connection">
      <ThemedText accessibilityRole="alert">{`Couldn't load ${what}. ${message}`}</ThemedText>
      {keptNote ? <ThemedText color="muted">{keptNote}</ThemedText> : null}
      <Button
        label="Retry loading"
        accessibilityLabel={`Retry loading ${noun}`}
        variant="secondary"
        onPress={onRetry}
      />
    </Card>
  );
}
