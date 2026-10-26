import { useRouter } from "expo-router";
import { AppBar } from "@/components/app-bar";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";

import { useProfileSession } from "../connection-context";

/** Settings: the connection, the profile and its weight unit. The token is never shown. */
export function SettingsScreen() {
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
      <Card
        title="Weight unit"
        body={
          session.profile.weight_unit
            ? `${session.profile.weight_unit} · configured on the server`
            : "Connect to load the server's weight unit"
        }
      />
      <Card title="Appearance" body="Use device setting" />
    </Screen>
  );
}
