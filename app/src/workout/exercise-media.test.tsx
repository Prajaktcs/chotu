import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { useIsFocused } from "expo-router";
import { AppState, type AppStateStatus, Platform } from "react-native";
import type * as ReactNative from "react-native";

import { Button } from "@/components/button";
import { useConnection } from "@/connection";
import { createPlayer, players } from "@/test/exercise-video-mock";
import type * as VideoMock from "@/test/exercise-video-mock";

import { ExerciseMedia } from "./exercise-media";

jest.mock("expo-video", () => jest.requireActual<typeof VideoMock>("@/test/exercise-video-mock"));
jest.mock("expo-image", () => ({
  Image: jest.requireActual<typeof ReactNative>("react-native").View,
}));
jest.mock("expo-router", () => ({ useIsFocused: jest.fn() }));
jest.mock("@/connection", () => ({ useConnection: jest.fn() }));

const SERVER = "https://mini.ts.net:8787";
const VIDEO = `/v1/exercise-media/${"a".repeat(64)}/video`;
const POSTER = `/v1/exercise-media/${"b".repeat(64)}/poster`;
const MEDIA = { video_url: VIDEO, poster_url: POSTER };
const UNAVAILABLE = "Demo unavailable. You can still log this exercise.";
let onAppState: ((state: AppStateStatus) => void) | undefined;
const removeAppStateListener = jest.fn();
const initialAppState = Object.getOwnPropertyDescriptor(AppState, "currentState");

function playerAt(index: number) {
  const player = players[index];
  if (!player) throw new Error(`Expected player ${index}`);
  return player;
}

function connection(serverUrl: string | null) {
  jest.mocked(useConnection).mockReturnValue({
    status: "ready",
    serverUrl,
    hasToken: false,
    profile: null,
    weightUnitFor: () => "lb",
    client: null,
    deviceClient: null,
    saveServer: jest.fn(),
    replaceToken: jest.fn(),
    chooseProfile: jest.fn(),
    clearProfile: jest.fn(),
    setWeightUnit: jest.fn(),
    verify: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  players.length = 0;
  onAppState = undefined;
  connection(SERVER);
  jest.mocked(useIsFocused).mockReturnValue(true);
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active" });
  jest.replaceProperty(Platform, "OS", "ios");
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    onAppState = listener;
    return { remove: removeAppStateListener };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  if (initialAppState) Object.defineProperty(AppState, "currentState", initialAppState);
});

describe("ExerciseMedia", () => {
  it("renders nothing without curated media", async () => {
    const view = await render(<ExerciseMedia media={undefined} name="Squat" visible />);
    expect(view.toJSON()).toBeNull();
    expect(createPlayer).not.toHaveBeenCalled();
  });

  it("mounts only a visible cached poster, and creates no player until a poster tap", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible={false} />);
    expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(createPlayer).not.toHaveBeenCalled();

    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(screen.getByTestId("exercise-media-poster").props).toMatchObject({
      source: { uri: `${SERVER}${POSTER}` },
      cachePolicy: "memory-disk",
      style: { width: "100%", aspectRatio: 16 / 9 },
    });
    expect(createPlayer).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("exercise-media-poster"));
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(playerAt(0).source).toEqual({ uri: `${SERVER}${VIDEO}`, useCaching: true });
    expect(playerAt(0)).toMatchObject({
      loop: true,
      muted: true,
      volume: 0,
      staysActiveInBackground: false,
    });
    expect(playerAt(0).play).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
    expect(screen.getByTestId("exercise-media-video").props).toMatchObject({
      nativeControls: false,
      fullscreenOptions: { enable: false },
      allowsPictureInPicture: false,
    });
  });

  it("activates an onscreen poster only after its parent grants the single player slot", async () => {
    const onActivate = jest.fn();
    const view = await render(
      <ExerciseMedia
        media={MEDIA}
        name="Squat"
        visible={false}
        posterVisible
        onActivate={onActivate}
      />,
    );
    expect(screen.getByTestId("exercise-media-poster")).toBeTruthy();
    expect(createPlayer).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(createPlayer).not.toHaveBeenCalled();

    await view.rerender(
      <ExerciseMedia media={MEDIA} name="Squat" visible posterVisible onActivate={onActivate} />,
    );
    expect(createPlayer).toHaveBeenCalledTimes(1);
    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible={false} posterVisible />);
    expect(playerAt(0).release).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("exercise-media-poster")).toBeTruthy();
    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible posterVisible />);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("exercise-media-poster")).toBeTruthy();
    await view.rerender(
      <ExerciseMedia media={MEDIA} name="Squat" visible={false} posterVisible={false} />,
    );
    expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
  });

  it("exposes accessible play/pause without ever enabling audio", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    await fireEvent.press(screen.getByRole("button", { name: "Pause demo for Squat" }));
    expect(playerAt(0).pause).toHaveBeenCalledTimes(1);
    expect(playerAt(0).playing).toBe(false);
    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(playerAt(0).play).toHaveBeenCalledTimes(1);
    expect(playerAt(0).playing).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    expect(playerAt(0).play).toHaveBeenCalledTimes(2);
    expect(playerAt(0).muted).toBe(true);
    expect(playerAt(0).volume).toBe(0);
  });

  it("releases offscreen and requires a fresh tap when visible again", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    const player = playerAt(0);

    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible={false} />);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("exercise-media-video")).toBeNull();
    expect(screen.queryByTestId("exercise-media-poster")).toBeNull();

    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(screen.getByTestId("exercise-media-poster")).toBeTruthy();
    expect(createPlayer).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    expect(createPlayer).toHaveBeenCalledTimes(2);
  });

  it.each(["inactive", "background"] as const)(
    "releases in %s and does not resume automatically",
    async (state) => {
      const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
      await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
      await act(() => onAppState?.(state));
      expect(playerAt(0).release).toHaveBeenCalledTimes(1);
      expect(playerAt(0).pause).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("exercise-media-video")).toBeNull();
      expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
      await act(() => onAppState?.("active"));
      expect(screen.getByTestId("exercise-media-poster")).toBeTruthy();
      expect(createPlayer).toHaveBeenCalledTimes(1);
      await view.unmount();
      expect(removeAppStateListener).toHaveBeenCalledTimes(1);
    },
  );

  it("releases on navigation blur, and keeps a blurred screen completely lazy", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    jest.mocked(useIsFocused).mockReturnValue(false);
    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(playerAt(0).release).toHaveBeenCalledTimes(1);
    expect(playerAt(0).pause).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
    expect(screen.queryByTestId("exercise-media-video")).toBeNull();
    jest.mocked(useIsFocused).mockReturnValue(true);
    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Play demo for Squat" })).toBeTruthy();
  });

  it("releases a recycled exercise even when two exercises share the same media URLs", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    await view.rerender(<ExerciseMedia media={MEDIA} name="Lunge" visible />);
    expect(playerAt(0).release).toHaveBeenCalledTimes(1);
    expect(playerAt(0).pause).toHaveBeenCalledTimes(1);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("exercise-media-video")).toBeNull();
    expect(screen.getByRole("button", { name: "Play demo for Lunge" })).toBeTruthy();
  });

  it("unmounts a player when its server or media identity changes", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    connection("https://other.ts.net");
    await view.rerender(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(playerAt(0).release).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("exercise-media-poster").props.source).toEqual({
      uri: `https://other.ts.net${POSTER}`,
    });
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    await view.rerender(
      <ExerciseMedia
        media={{ ...MEDIA, video_url: `/v1/exercise-media/${"c".repeat(64)}/video` }}
        name="Squat"
        visible
      />,
    );
    expect(playerAt(1).release).toHaveBeenCalledTimes(1);
    expect(createPlayer).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("exercise-media-poster")).toBeTruthy();
  });

  it("uses a direct header-free source and browser HTTP caching on web", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    expect(screen.getByTestId("exercise-media-poster").props.source).toEqual({
      uri: `${SERVER}${POSTER}`,
    });
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    expect(playerAt(0).source).toEqual({ uri: `${SERVER}${VIDEO}`, useCaching: false });
  });

  it.each([`${SERVER}/chotu`, `${SERVER}/chotu/`])(
    "preserves the API deployment base path for posters and videos: %s",
    async (serverUrl) => {
      connection(serverUrl);
      await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
      expect(screen.getByTestId("exercise-media-poster").props.source).toEqual({
        uri: `${SERVER}/chotu${POSTER}`,
      });
      await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
      expect(playerAt(0).source).toEqual({
        uri: `${SERVER}/chotu${VIDEO}`,
        useCaching: true,
      });
    },
  );

  it.each([
    "https://external.example/demo.mp4",
    `https://mini.ts.net:8787${VIDEO}`,
    `//external.example${VIDEO}`,
    "/v1/workout",
    `${VIDEO}?token=secret`,
    `${VIDEO}#fragment`,
    POSTER,
    "/v1/exercise-media/not-a-hash/video",
  ])("rejects a non-public-media video path: %s", async (video_url) => {
    await render(<ExerciseMedia media={{ ...MEDIA, video_url }} name="Squat" visible />);
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
    expect(createPlayer).not.toHaveBeenCalled();
  });

  it.each(["https://external.example/poster.jpg", "/v1/workout", VIDEO])(
    "rejects a non-public-media poster path: %s",
    async (poster_url) => {
      await render(<ExerciseMedia media={{ ...MEDIA, poster_url }} name="Squat" visible />);
      expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
      expect(screen.queryByTestId("exercise-media-poster")).toBeNull();
      expect(createPlayer).not.toHaveBeenCalled();
    },
  );

  it.each([null, "not-a-server", "file:///tmp", "https://token:secret@mini.ts.net"])(
    "fails open when the server is unavailable or invalid: %s",
    async (serverUrl) => {
      connection(serverUrl);
      await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
      expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
      expect(createPlayer).not.toHaveBeenCalled();
    },
  );

  it("shows accessible text on poster failure without creating a player", async () => {
    await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent(screen.getByTestId("exercise-media-poster"), "error", { error: "offline" });
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(createPlayer).not.toHaveBeenCalled();
  });

  it("releases a failed video and leaves logging usable", async () => {
    const logSet = jest.fn();
    await render(
      <>
        <ExerciseMedia media={MEDIA} name="Squat" visible />
        <Button label="Log set" accessibilityLabel="Log set" onPress={logSet} />
      </>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    await act(() => playerAt(0).emit("statusChange", { status: "error" }));
    expect(playerAt(0).release).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
    await fireEvent.press(screen.getByRole("button", { name: "Log set" }));
    expect(logSet).toHaveBeenCalledTimes(1);
  });

  it("contains a player construction failure instead of crashing the workout", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await createPlayer.withImplementation(
      () => {
        throw new Error("Video backend unavailable");
      },
      async () => {
        await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
        await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
        expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
      },
    );
    consoleError.mockRestore();
  });

  it("releases the player on component unmount", async () => {
    const view = await render(<ExerciseMedia media={MEDIA} name="Squat" visible />);
    await fireEvent.press(screen.getByRole("button", { name: "Play demo for Squat" }));
    await view.unmount();
    expect(playerAt(0).release).toHaveBeenCalledTimes(1);
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
  });
});
