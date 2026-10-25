import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";

export default function Home() {
  return (
    <Screen style={{ justifyContent: "center" }}>
      <ThemedText variant="headline" accessibilityRole="header">
        Chotu
      </ThemedText>
      <ThemedText color="muted">Workout logging is on its way.</ThemedText>
    </Screen>
  );
}
