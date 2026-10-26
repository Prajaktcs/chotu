import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";

import type { WeightUnit } from "@/api";
import { AppBar } from "@/components/app-bar";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/theme";

import { useProfileSession } from "../connection-context";

const UNITS: WeightUnit[] = ["lb", "kg"];

/** Settings: the connection, the profile and its weight unit. The token is never shown. */
export function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const session = useProfileSession();

  return (
    <Screen scroll>
      <AppBar
        title="Settings"
        action={{
          label: "Done",
          accessibilityLabel: "Back to workout",
          onPress: () => {
            if (router.canGoBack()) router.back();
            else router.replace("/workout");
          },
        }}
      />
      <ThemedText color="muted">Device connection and profile</ThemedText>
      <Card title="Server" body={session.serverUrl} />
      <Card title="Device token" body="Saved · hidden" />
      <Card title="Profile" body={session.profile.name} />
      <Button
        variant="secondary"
        label="Switch profile"
        accessibilityLabel="Switch profile"
        onPress={() => router.push("/profile")}
      />
      <Button
        variant="text"
        label="Replace device token"
        accessibilityLabel="Replace device token"
        onPress={() => router.push({ pathname: "/connection/token", params: { mode: "replace" } })}
      />
      <Card title="Weight unit" body={`${session.weightUnit} · set on this phone`}>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Weight unit"
          style={{ flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.sm }}
        >
          {UNITS.map((unit) => {
            const selected = unit === session.weightUnit;
            return (
              <Pressable
                key={unit}
                accessibilityRole="radio"
                accessibilityLabel={unit === "lb" ? "Pounds" : "Kilograms"}
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  void session.setWeightUnit(unit);
                }}
                style={{
                  flex: 1,
                  minHeight: theme.minTapTarget,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: theme.radii.full,
                  backgroundColor: selected ? theme.colors.primary : theme.colors.container,
                }}
              >
                <ThemedText medium color={selected ? "onPrimary" : "primary"}>
                  {selected ? `✓ ${unit}` : unit}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
      </Card>
      <Card title="Appearance" body="Use device setting" />
    </Screen>
  );
}
