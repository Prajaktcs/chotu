import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/button";
import { Screen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/theme";

import { useConnection } from "../connection-context";
import { messageForError, routeForApiError } from "../error-routes";
import { meQueryKey } from "../queries";
import { normalizeServerUrl } from "../server-url";

/**
 * "Connect to Chotu": server address and device token. Connect saves them,
 * checks `/v1/health` then `/v1/me`, and opens the profile picker. A failure
 * opens its recovery screen, which works on the saved connection.
 */
export function SetupScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connection = useConnection();
  const [address, setAddress] = useState(connection.serverUrl ?? "");
  const [token, setToken] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const keepsSavedToken = connection.hasToken;

  const connect = async () => {
    setFailure(null);
    const url = normalizeServerUrl(address);
    const trimmedToken = token.trim();
    setAddressError(url.ok ? null : url.error);
    const missingToken = trimmedToken === "" && !keepsSavedToken;
    setTokenError(missingToken ? "Enter the device token." : null);
    if (!url.ok || missingToken) return;

    setConnecting(true);
    try {
      await connection.saveServer(url.url, trimmedToken === "" ? undefined : trimmedToken);
      // The token now lives only in storage; clear it from this screen.
      setToken("");
      setAddress(url.url);
      const me = await connection.verify();
      queryClient.setQueryData(meQueryKey(url.url), me);
      router.replace("/profile");
    } catch (error) {
      const route = routeForApiError(error);
      if (route) router.replace(route);
      else setFailure(messageForError(error));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Screen scroll>
      <ThemedText variant="headline" accessibilityRole="header">
        Connect to Chotu
      </ThemedText>
      <ThemedText color="muted">
        Use the server address and device token provided for this phone.
      </ThemedText>
      <TextField
        label="Server address"
        value={address}
        onChangeText={setAddress}
        placeholder="https://mini.ts.net:8787"
        keyboardType="url"
        error={addressError}
      />
      <TextField
        label="Device token"
        value={token}
        onChangeText={setToken}
        secure
        hint={
          keepsSavedToken
            ? "A token is saved. Leave this empty to keep it."
            : "The token is hidden after saving."
        }
        error={tokenError}
      />
      {failure ? (
        <ThemedText color="error" accessibilityRole="alert">
          {failure}
        </ThemedText>
      ) : null}
      <View style={{ flex: 1 }} />
      <Button
        label={connecting ? "Connecting…" : "Connect"}
        accessibilityLabel="Connect"
        disabled={connecting}
        onPress={() => {
          void connect();
        }}
      />
      <View style={{ gap: theme.spacing.sm }}>
        <ThemedText color="muted" variant="label">
          Connect to Tailscale before continuing.
        </ThemedText>
        <Button
          variant="text"
          label="Connection help"
          accessibilityLabel="Connection help"
          onPress={() => setShowHelp((shown) => !shown)}
        />
        {showHelp ? (
          <ThemedText color="muted" variant="label">
            Open the Tailscale app and check it says Connected. The server address is the Mac
            mini&apos;s Tailscale name with port 8787. The device token comes from whoever runs
            Chotu, who makes one with `just api-token`.
          </ThemedText>
        ) : null}
      </View>
    </Screen>
  );
}
