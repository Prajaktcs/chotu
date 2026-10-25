import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import type { Profile } from "@/api";
import { Button } from "@/components/button";
import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/theme";

import { useConnection } from "../connection-context";
import { messageForError, routeForApiError } from "../error-routes";
import { meQueryKey } from "../queries";

/**
 * "Choose your profile": one button per profile `/v1/me` allows for this
 * device. Choosing one saves it and opens the workout.
 */
export function ProfilePickerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();
  const { deviceClient, serverUrl } = connection;
  const [saving, setSaving] = useState(false);

  const me = useQuery({
    queryKey: meQueryKey(serverUrl),
    queryFn: () => {
      if (!deviceClient) throw new Error("No saved connection");
      return deviceClient.me();
    },
    enabled: deviceClient !== null,
    // Setup seeds this from its own check; don't ask the server twice.
    staleTime: 30_000,
    retry: false,
  });

  const recovery = me.error ? routeForApiError(me.error) : null;
  useEffect(() => {
    if (recovery) router.replace(recovery);
  }, [recovery, router]);

  const choose = async (profile: Profile) => {
    setSaving(true);
    try {
      await connection.chooseProfile(profile);
      router.dismissTo("/workout");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll>
      <ThemedText variant="headline" accessibilityRole="header">
        Choose your profile
      </ThemedText>
      <ThemedText color="muted">Only profiles allowed for this device appear here.</ThemedText>
      {me.isPending ? <Progress label="Loading profiles" /> : null}
      {me.error && !recovery ? (
        <View style={{ gap: theme.spacing.sm }}>
          <ThemedText color="error" accessibilityRole="alert">
            {messageForError(me.error)}
          </ThemedText>
          <Button
            variant="secondary"
            label="Try again"
            accessibilityLabel="Try again"
            onPress={() => {
              void me.refetch();
            }}
          />
        </View>
      ) : null}
      {me.data?.profiles.length === 0 ? (
        <ThemedText>
          No profiles are allowed for this device yet. Add one to its members in config.yaml.
        </ThemedText>
      ) : null}
      <View style={{ gap: theme.spacing.md }}>
        {me.data?.profiles.map((profile) => {
          const unit = connection.weightUnitFor(profile.id);
          return (
            <Button
              key={profile.id}
              variant="secondary"
              label={`${profile.name} · ${unit}`}
              accessibilityLabel={`Use profile ${profile.name}, weights in ${unit}`}
              disabled={saving}
              onPress={() => {
                void choose(profile);
              }}
            />
          );
        })}
      </View>
      <View style={{ flex: 1 }} />
      <ThemedText color="muted" variant="label">
        You can switch profiles from settings. Your token stays hidden.
      </ThemedText>
    </Screen>
  );
}
