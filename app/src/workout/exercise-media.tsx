import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { Component, type ReactNode, useCallback, useEffect, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, View } from "react-native";

import { Button } from "@/components/button";
import { ThemedText } from "@/components/themed-text";
import { useConnection } from "@/connection";
import { useTheme } from "@/theme";

export type ExerciseMediaProps = {
  media: { video_url: string; poster_url: string } | undefined;
  name: string;
  visible: boolean;
  /** A list can show several posters while allowing only one player. */
  posterVisible?: boolean;
  onActivate?: () => void;
};

const MEDIA_PATH = /^\/v1\/exercise-media\/[a-f0-9]{64}\/(video|poster)$/;

/** Accept only the public, content-addressed media routes, never an API or external URL. */
function mediaUrl(serverUrl: string | null, path: string, kind: "video" | "poster") {
  if (!serverUrl || MEDIA_PATH.exec(path)?.[1] !== kind) {
    return null;
  }
  try {
    const server = new URL(serverUrl);
    if (!["https:", "http:"].includes(server.protocol) || server.username || server.password) {
      return null;
    }
    return new URL(path, server).href;
  } catch {
    return null;
  }
}

/** Optional media never uses the authenticated API client or affects set logging. */
export function ExerciseMedia({
  media,
  name,
  visible,
  posterVisible = visible,
  onActivate,
}: ExerciseMediaProps) {
  const { serverUrl } = useConnection();
  const focused = useIsFocused();
  const theme = useTheme();
  const [appState, setAppState] = useState(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription?.remove();
  }, []);

  if (!media) return null;
  const videoUrl = mediaUrl(serverUrl, media.video_url, "video");
  const posterUrl = mediaUrl(serverUrl, media.poster_url, "poster");
  const active = posterVisible && focused && appState === "active";

  return (
    <View
      style={{
        backgroundColor: theme.colors.container,
        borderRadius: theme.radii.panel,
        overflow: "hidden",
      }}
    >
      {!videoUrl || !posterUrl ? (
        <MediaUnavailable />
      ) : active ? (
        <MediaErrorBoundary key={`${name}:${videoUrl}:${posterUrl}`}>
          <ActiveMedia
            name={name}
            videoUrl={videoUrl}
            posterUrl={posterUrl}
            allowedToPlay={visible}
            onActivate={onActivate}
          />
        </MediaErrorBoundary>
      ) : (
        // Keep the same geometry while offscreen, without mounting an image or a player.
        <>
          <View style={styles.stage} />
          <View style={{ height: theme.buttonHeights.secondary, justifyContent: "center" }}>
            <ThemedText style={{ textAlign: "center" }}>Play demo</ThemedText>
          </View>
        </>
      )}
    </View>
  );
}

function ActiveMedia({
  name,
  videoUrl,
  posterUrl,
  allowedToPlay,
  onActivate,
}: {
  name: string;
  videoUrl: string;
  posterUrl: string;
  allowedToPlay: boolean;
  onActivate?: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [wasAllowed, setWasAllowed] = useState(allowedToPlay);
  const [failed, setFailed] = useState(false);
  const reportError = useCallback(() => setFailed(true), []);
  if (wasAllowed !== allowedToPlay) {
    setWasAllowed(allowedToPlay);
    if (!allowedToPlay) setStarted(false);
  }

  function startPlayback() {
    setStarted(true);
    onActivate?.();
  }

  if (failed) return <MediaUnavailable />;
  if (started && allowedToPlay) {
    return <DemoPlayer name={name} uri={videoUrl} onError={reportError} />;
  }
  return (
    <>
      <Pressable accessible={false} onPress={startPlayback}>
        <Image
          source={{ uri: posterUrl }}
          style={styles.stage}
          contentFit="contain"
          cachePolicy="memory-disk"
          accessible={false}
          onError={() => setFailed(true)}
          testID="exercise-media-poster"
        />
      </Pressable>
      <Button
        label="Play demo"
        accessibilityLabel={`Play demo for ${name}`}
        variant="secondary"
        onPress={startPlayback}
      />
    </>
  );
}

function DemoPlayer({ name, uri, onError }: { name: string; uri: string; onError: () => void }) {
  // expo-video caching is native-only. Web uses the browser HTTP disk cache and
  // the server's immutable, hash-addressed response, with no extra fetch/headers.
  // useVideoPlayer releases its player when this conditional child unmounts.
  const player = useVideoPlayer({ uri, useCaching: Platform.OS !== "web" }, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.staysActiveInBackground = false;
  });
  const [playing, setPlaying] = useState(player.playing);

  useEffect(() => {
    if (player.status === "error") {
      onError();
      return undefined;
    }
    const status = player.addListener("statusChange", (event) => {
      if (event.status === "error") onError();
    });
    const playback = player.addListener("playingChange", (event) => setPlaying(event.isPlaying));
    // On web, setup runs before VideoView attaches its HTML video element.
    // Start after that child's mount effect, not in the player constructor.
    try {
      player.play();
    } catch {
      onError();
    }
    return () => {
      status.remove();
      playback.remove();
      player.pause();
    };
  }, [player, onError]);

  function togglePlayback() {
    try {
      if (player.playing) player.pause();
      else player.play();
    } catch {
      onError();
    }
  }

  return (
    <>
      <VideoView
        player={player}
        style={styles.stage}
        contentFit="contain"
        nativeControls={false}
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={false}
        playsInline
        accessible={false}
        testID="exercise-media-video"
      />
      <Button
        label={playing ? "Pause demo" : "Play demo"}
        accessibilityLabel={`${playing ? "Pause" : "Play"} demo for ${name}`}
        variant="secondary"
        onPress={togglePlayback}
      />
    </>
  );
}

function MediaUnavailable() {
  const theme = useTheme();
  return (
    <>
      <View style={[styles.stage, styles.message, { padding: theme.spacing.lg }]}>
        <ThemedText accessibilityRole="alert" accessibilityLiveRegion="polite">
          Demo unavailable. You can still log this exercise.
        </ThemedText>
      </View>
      <View style={{ height: theme.buttonHeights.secondary }} />
    </>
  );
}

/** A native/player rendering failure must not take the workout screen with it. */
class MediaErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <MediaUnavailable /> : this.props.children;
  }
}

const styles = StyleSheet.create({
  stage: { width: "100%", aspectRatio: 16 / 9 },
  message: { alignItems: "center", justifyContent: "center" },
});
