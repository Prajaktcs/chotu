import { useRouter } from "expo-router";
import { View } from "react-native";

import { AppBar } from "@/components/app-bar";
import { BottomNav } from "@/components/bottom-nav";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import { useProfileSession } from "@/connection";
import { useTheme } from "@/theme";

/** The workout tab. A placeholder until the logging screen lands (#119). */
export function WorkoutPlaceholderScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { profile, weightUnit } = useProfileSession();
  return (
    <Screen>
      <AppBar
        title="Workout"
        action={{
          label: "Profile",
          accessibilityLabel: "Profile and settings",
          onPress: () => router.push("/settings"),
        }}
      />
      <View style={{ flex: 1, gap: theme.spacing.sm }}>
        <ThemedText variant="overline" color="muted">
          {`${profile.name} · ${weightUnit}`}
        </ThemedText>
        <ThemedText variant="headline">{`Logging as ${profile.name}`}</ThemedText>
        <ThemedText color="muted">Workout logging is on its way.</ThemedText>
      </View>
      <BottomNav selected="workout" />
    </Screen>
  );
}
