import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { ApiError, APP_VERSION } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Screen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/theme";

import { useConnection } from "../connection-context";
import { messageForError, routeForApiError } from "../error-routes";
import { pendingSetsLabel, usePendingSetCount } from "../pending";
import { type Reconnect, useReconnect } from "../use-reconnect";

type RecoveryLayoutProps = {
  title: string;
  description: string;
  children?: ReactNode;
  /** Buttons, placed in the bottom half. */
  actions: ReactNode;
  footer?: string;
  error?: string | null;
};

function RecoveryLayout({
  title,
  description,
  children,
  actions,
  footer,
  error,
}: RecoveryLayoutProps) {
  const theme = useTheme();
  return (
    <Screen scroll>
      <ThemedText variant="headline" accessibilityRole="header">
        {title}
      </ThemedText>
      <ThemedText color="muted">{description}</ThemedText>
      {children}
      {error ? (
        <ThemedText color="error" accessibilityRole="alert">
          {error}
        </ThemedText>
      ) : null}
      <View style={{ flex: 1 }} />
      <View style={{ gap: theme.spacing.sm }}>{actions}</View>
      {footer ? (
        <ThemedText color="muted" variant="label">
          {footer}
        </ThemedText>
      ) : null}
    </Screen>
  );
}

/** "N sets waiting to send", only when the offline queue reports a count. */
function PendingSetsCard() {
  const count = usePendingSetCount();
  if (count === null || count <= 0) return null;
  return (
    <Card title="Waiting on this phone" body={pendingSetsLabel(count)} testID="pending-sets" />
  );
}

function TryAgainButton({
  reconnect,
  label = "Try again",
}: {
  reconnect: Reconnect;
  label?: string;
}) {
  const { checking } = reconnect;
  return (
    <Button
      label={checking ? "Checking…" : label}
      accessibilityLabel={label}
      disabled={checking}
      onPress={() => {
        void reconnect.reconnect();
      }}
    />
  );
}

/** Network error: the server can't be reached, usually because Tailscale is off. */
export function TailscaleScreen() {
  const router = useRouter();
  const reconnect = useReconnect();
  return (
    <RecoveryLayout
      title="Connect to Tailscale"
      description="Chotu's private server can't be reached."
      error={reconnect.error}
      actions={
        <>
          <TryAgainButton reconnect={reconnect} />
          <Button
            variant="text"
            label="Edit server address"
            accessibilityLabel="Edit server address"
            onPress={() => router.push("/setup")}
          />
        </>
      }
      footer="Any sets already waiting on this phone are kept."
    >
      <Card title="1 · Open Tailscale" body="Check that it says Connected." />
      <Card title="2 · Check the server address" body="It should end in .ts.net:8787." />
    </RecoveryLayout>
  );
}

/**
 * 401: the token is invalid or revoked. With `replace`, the same form is the
 * Settings "Replace device token" screen.
 */
export function TokenScreen({ replace = false }: { replace?: boolean }) {
  const router = useRouter();
  const connection = useConnection();
  const { profile } = connection;
  const [token, setToken] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = token.trim();
    setError(null);
    if (trimmed === "") {
      setFieldError("Enter the new device token.");
      return;
    }
    setFieldError(null);
    setSaving(true);
    // Clear the field whatever happens: the token is never shown again.
    setToken("");
    try {
      await connection.replaceToken(trimmed);
      router.dismissTo(profile ? "/workout" : "/profile");
    } catch (failure) {
      if (failure instanceof ApiError && failure.kind === "unauthorized") {
        setError("That token wasn't accepted either. Check it and try again.");
      } else {
        const route = routeForApiError(failure);
        if (route) router.replace(route);
        else setError(messageForError(failure));
      }
    } finally {
      setSaving(false);
    }
  };

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace(profile ? "/settings" : "/setup");
  };

  return (
    <RecoveryLayout
      title={replace ? "Replace device token" : "Token not accepted"}
      description={
        replace
          ? "Enter the new device token for this phone. The saved token is replaced."
          : "The server is reachable, but this device token is invalid or has been revoked."
      }
      error={error}
      actions={
        <>
          <Button
            label={saving ? "Saving…" : "Save and reconnect"}
            accessibilityLabel="Save and reconnect"
            disabled={saving}
            onPress={() => {
              void save();
            }}
          />
          <Button variant="text" label="Back" accessibilityLabel="Back" onPress={back} />
        </>
      }
      footer="Saved tokens stay hidden and are never included in error details."
    >
      <TextField
        label="New device token"
        value={token}
        onChangeText={setToken}
        secure
        error={fieldError}
      />
    </RecoveryLayout>
  );
}

/** 5xx, or a reply the app can't read: the server is up behind Tailscale but failing. */
export function ServerUnavailableScreen() {
  const router = useRouter();
  const { profile } = useConnection();
  const reconnect = useReconnect();
  return (
    <RecoveryLayout
      title="Server unavailable"
      description="Chotu's server answered with an error. It may be restarting."
      error={reconnect.error}
      actions={
        <>
          <TryAgainButton reconnect={reconnect} />
          {profile ? (
            <Button
              variant="secondary"
              label="Keep logging offline"
              accessibilityLabel="Keep logging offline"
              onPress={() => router.replace({ pathname: "/workout", params: { offline: "1" } })}
            />
          ) : null}
        </>
      }
    >
      <PendingSetsCard />
    </RecoveryLayout>
  );
}

/** 426: this app is older than the server supports. */
export function UpdateScreen({ requiredVersion }: { requiredVersion: string | null }) {
  const [showHelp, setShowHelp] = useState(false);
  const reconnect = useReconnect();
  return (
    <RecoveryLayout
      title="Update Chotu"
      description="This version of the app is older than the server supports."
      error={reconnect.error}
      actions={
        <>
          <Button
            label="How to update"
            accessibilityLabel="How to update"
            onPress={() => setShowHelp(true)}
          />
          <TryAgainButton reconnect={reconnect} label="Check again" />
        </>
      }
    >
      <Card title="Installed version" body={APP_VERSION} />
      <Card
        title="Required version"
        body={requiredVersion ? `${requiredVersion} or later` : "Newer than this one"}
      />
      <PendingSetsCard />
      {showHelp ? (
        <ThemedText testID="update-help">
          Install the latest signed APK over this app, then reopen Chotu. Do not uninstall or clear
          storage.
        </ThemedText>
      ) : null}
    </RecoveryLayout>
  );
}

/** 403: this device may not use the chosen profile. */
export function ProfileDeniedScreen() {
  const router = useRouter();
  const connection = useConnection();
  const [busy, setBusy] = useState(false);
  return (
    <RecoveryLayout
      title="Choose another profile"
      description="This device doesn't have permission to use that profile."
      actions={
        <>
          <Button
            label="Choose allowed profile"
            accessibilityLabel="Choose allowed profile"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void connection
                .clearProfile()
                .then(() => router.replace("/profile"))
                .finally(() => setBusy(false));
            }}
          />
          <Button
            variant="text"
            label="Connection settings"
            accessibilityLabel="Connection settings"
            onPress={() => router.push("/settings")}
          />
        </>
      }
      footer="Only profiles returned for this device are shown."
    />
  );
}
