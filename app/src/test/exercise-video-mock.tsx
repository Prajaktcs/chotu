import { useEffect, useState } from "react";
import { View, type ViewProps } from "react-native";

type PlayerEvent = { status?: string; isPlaying?: boolean };
type Listener = (event: PlayerEvent) => void;
type Source = { uri: string; useCaching: boolean };

export class MockVideoPlayer {
  loop = false;
  muted = false;
  volume = 1;
  staysActiveInBackground = true;
  playing = false;
  status = "readyToPlay";
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly source: Source) {}

  play = jest.fn(() => {
    this.playing = true;
    this.emit("playingChange", { isPlaying: true });
  });

  pause = jest.fn(() => {
    this.playing = false;
    this.emit("playingChange", { isPlaying: false });
  });

  release = jest.fn(() => {
    this.playing = false;
    this.listeners.clear();
  });

  addListener(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  }

  emit(event: string, payload: PlayerEvent) {
    if (payload.status) this.status = payload.status;
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

export const players: MockVideoPlayer[] = [];
export const createPlayer = jest.fn((source: Source) => {
  const player = new MockVideoPlayer(source);
  players.push(player);
  return player;
});

/** Mirrors useVideoPlayer ownership: allocate on mount, release on unmount. */
export function useVideoPlayer(source: Source, setup: (player: MockVideoPlayer) => void) {
  const [player] = useState(() => {
    const instance = createPlayer(source);
    setup(instance);
    return instance;
  });
  useEffect(() => () => player.release(), [player]);
  return player;
}

export function VideoView(props: ViewProps & { player: MockVideoPlayer }) {
  return <View {...props} />;
}
