import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import { APP_VERSION, type Me } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch, type Routes } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";

jest.mock("expo-secure-store", () =>
  jest
    .requireActual<typeof import("@/test/secure-store-mock")>("@/test/secure-store-mock")
    .createSecureStoreMock(),
);

const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

const SERVER = "https://mini.ts.net:8787";
const TOKEN = "alex_phone.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NEW_TOKEN = "alex_phone.fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const ME: Me = {
  device: "kitchen_ipad",
  member: null,
  profiles: [
    { id: "alex", name: "Alex" },
    { id: "jordan", name: "Jordan" },
  ],
};

const ok: Routes = {
  "GET /v1/health": () => json(200, HEALTH),
  "GET /v1/me": () => json(200, ME),
  "GET /v1/workout": () => json(200, { workout: null }),
};

function saved(profile: { id: string; name: string } | null, units = {}) {
  secure.items.set(TOKEN_KEY, TOKEN);
  secure.items.set(SETTINGS_KEY, JSON.stringify({ version: 1, serverUrl: SERVER, profile, units }));
}

function storedSettings(): { profile: unknown; units: unknown; serverUrl: unknown } {
  return JSON.parse(secure.items.get(SETTINGS_KEY) ?? "null");
}

/**
 * Everything rendered (text and string props such as accessibility labels), as
 * one string: the token must never be in it. Element-valued props (a
 * ScrollView's refreshControl) are skipped.
 */
function rendered(): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      parts.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === "object" && node !== null && "props" in node) {
      const props = typeof node.props === "object" && node.props !== null ? node.props : {};
      for (const value of Object.values(props)) {
        if (typeof value === "string") parts.push(value);
        else if (typeof value === "object" && value !== null && !("$$typeof" in value)) {
          parts.push(JSON.stringify(value));
        }
      }
      if ("children" in node) walk(node.children);
    }
  };
  walk(screen.toJSON());
  return parts.join("\n");
}

/** Puts two unsent sets in Alex's queue on this phone. */
async function twoPendingSets() {
  const item = {
    exercise: "Bench press",
    weight: 135,
    unit: "lb",
    reps: 8,
    performedAt: "2026-10-24T09:32:00-04:00",
    status: "pending",
  };
  await AsyncStorage.setItem(
    `chotu.set_queue.v1:${SERVER}#alex`,
    JSON.stringify({
      version: 1,
      items: [
        { ...item, requestId: "3f2b9c4e-8a1d-4c55-9a8e-2b7f0c1d9e6a" },
        { ...item, requestId: "0b6e1f7a-3c2d-4e5f-8a9b-1c2d3e4f5a6b" },
      ],
    }),
  );
}

let restoreFetch: () => void = () => undefined;
let calls: FetchCall[] = [];

function serve(routes: Routes) {
  restoreFetch();
  const mock = mockFetch(routes);
  calls = mock.calls;
  restoreFetch = mock.restore;
}

beforeEach(async () => {
  secure.reset();
  await AsyncStorage.clear();
  serve(ok);
});

afterEach(() => {
  restoreFetch();
});

async function connect(address = SERVER, token = TOKEN) {
  await fireEvent.changeText(await screen.findByLabelText("Server address"), address);
  await fireEvent.changeText(screen.getByLabelText("Device token"), token);
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
}

describe("launch", () => {
  it("opens setup on a fresh install", async () => {
    const router = await renderRouter("./src/app");

    expect(await screen.findByRole("header", { name: "Connect to Chotu" })).toBeTruthy();
    expect(router.getPathname()).toBe("/setup");
    expect(calls).toHaveLength(0);
  });

  it("opens the profile picker when no profile is chosen", async () => {
    saved(null);
    const router = await renderRouter("./src/app");

    expect(await screen.findByRole("header", { name: "Choose your profile" })).toBeTruthy();
    expect(router.getPathname()).toBe("/profile");
  });

  it("opens the workout when a profile is chosen", async () => {
    saved({ id: "alex", name: "Alex" });
    const router = await renderRouter("./src/app");

    expect(await screen.findByRole("header", { name: "No workout today" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
    expect(screen.getByRole("tab", { name: "Workout" })).toBeSelected();
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/workout" });
    expect(calls.at(-1)?.headers["x-chotu-member"]).toBe("alex");
  });

  it("sends a workout deep link without a profile to the picker", async () => {
    saved(null);
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });

    expect(await screen.findByRole("header", { name: "Choose your profile" })).toBeTruthy();
    expect(router.getPathname()).toBe("/profile");
  });
});

describe("setup", () => {
  it("checks health, then /me without a member, then shows the allowed profiles", async () => {
    const router = await renderRouter("./src/app");

    await connect("  mini.ts.net:8787/ ");

    expect(await screen.findByRole("header", { name: "Choose your profile" })).toBeTruthy();
    expect(router.getPathname()).toBe("/profile");
    expect(screen.getByRole("button", { name: "Use profile Alex, weights in lb" })).toBeTruthy();
    expect(screen.getByText("Jordan · lb")).toBeTruthy();
    expect(screen.queryByText(/Sam/)).toBeNull();

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/health",
      "GET /v1/me",
    ]);
    expect(calls[0]?.headers).not.toHaveProperty("authorization");
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]?.headers).not.toHaveProperty("x-chotu-member");

    expect(storedSettings()).toMatchObject({ serverUrl: SERVER, profile: null });
    expect(secure.items.get(TOKEN_KEY)).toBe(TOKEN);
    expect(rendered()).not.toContain(TOKEN);
  });

  it("validates the address and token before calling the server", async () => {
    await renderRouter("./src/app");

    await connect("http://mini.ts.net:8787", "");

    expect(await screen.findByText("Use an https:// address.")).toBeTruthy();
    expect(screen.getByText("Enter the device token.")).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(secure.items.size).toBe(0);
  });

  it("uses a secure, uncorrected token field", async () => {
    await renderRouter("./src/app");

    const field = await screen.findByLabelText("Device token");
    expect(field.props).toMatchObject({
      secureTextEntry: true,
      autoCapitalize: "none",
      autoCorrect: false,
    });
  });

  it.each([
    [
      "a network failure",
      {
        "GET /v1/health": () => {
          throw new TypeError("Network request failed");
        },
      },
      "Connect to Tailscale",
      "/connection/tailscale",
    ],
    [
      "a 502 from tailscale serve",
      { "GET /v1/health": () => new Response("Bad Gateway", { status: 502 }) },
      "Server unavailable",
      "/connection/unavailable",
    ],
    [
      "a 500 from /me",
      { ...ok, "GET /v1/me": () => json(500, { error: "internal error" }) },
      "Server unavailable",
      "/connection/unavailable",
    ],
    [
      "a 401",
      { ...ok, "GET /v1/me": () => json(401, { error: "missing or invalid device token" }) },
      "Token not accepted",
      "/connection/token",
    ],
    [
      "a 426",
      {
        ...ok,
        "GET /v1/me": () => json(426, { error: "app update required", min_app_version: "0.2.0" }),
      },
      "Update Chotu",
      "/connection/update",
    ],
  ] satisfies [string, Routes, string, string][])(
    "routes %s to %j",
    async (_, routes, header, pathname) => {
      serve(routes);
      const router = await renderRouter("./src/app");

      await connect();

      expect(await screen.findByRole("header", { name: header })).toBeTruthy();
      expect(router.getPathname()).toBe(pathname);
      expect(rendered()).not.toContain(TOKEN);
    },
  );

  it("shows the installed and required versions on the update screen", async () => {
    serve({
      ...ok,
      "GET /v1/me": () => json(426, { error: "app update required", min_app_version: "0.2.0" }),
    });
    await renderRouter("./src/app");

    await connect();

    expect(await screen.findByText("0.2.0 or later")).toBeTruthy();
    expect(screen.getByText(APP_VERSION)).toBeTruthy();
    expect(screen.queryByTestId("update-help")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "How to update" }));
    expect(screen.getByText(/Install the latest signed APK over this app/)).toBeTruthy();

    serve(ok);
    await fireEvent.press(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("header", { name: "Choose your profile" })).toBeTruthy();
  });
});

describe("profile picker", () => {
  it("saves the chosen profile and opens the workout", async () => {
    const router = await renderRouter("./src/app");
    await connect();

    await fireEvent.press(
      await screen.findByRole("button", { name: "Use profile Jordan, weights in lb" }),
    );

    expect(await screen.findByRole("header", { name: "No workout today" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
    expect(calls.at(-1)?.headers["x-chotu-member"]).toBe("jordan");
    expect(storedSettings().profile).toEqual({ id: "jordan", name: "Jordan" });
    expect(rendered()).not.toContain(TOKEN);
  });

  it("shows each profile's unit set on this phone", async () => {
    saved(null, { alex: "kg" });
    await renderRouter("./src/app");

    expect(await screen.findByText("Alex · kg")).toBeTruthy();
    expect(screen.getByText("Jordan · lb")).toBeTruthy();
  });
});

describe("recovery", () => {
  it("routes a 403 for the saved profile to Choose another profile", async () => {
    saved({ id: "sam", name: "Sam" });
    serve({
      "GET /v1/health": () => {
        throw new TypeError("offline");
      },
    });
    const router = await renderRouter("./src/app", { initialUrl: "/connection/tailscale" });
    expect(await screen.findByRole("header", { name: "Connect to Tailscale" })).toBeTruthy();

    serve({
      ...ok,
      "GET /v1/me": () => json(403, { error: "member not allowed for this device" }),
    });
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("header", { name: "Choose another profile" })).toBeTruthy();
    expect(router.getPathname()).toBe("/connection/profile-denied");
    expect(calls.at(-1)?.headers["x-chotu-member"]).toBe("sam");

    serve(ok);
    await fireEvent.press(screen.getByRole("button", { name: "Choose allowed profile" }));

    expect(await screen.findByRole("header", { name: "Choose your profile" })).toBeTruthy();
    expect(storedSettings().profile).toBeNull();
    expect(await screen.findByText("Alex · lb")).toBeTruthy();
  });

  it("replaces a rejected token and reconnects without showing it", async () => {
    saved({ id: "alex", name: "Alex" });
    const router = await renderRouter("./src/app", { initialUrl: "/connection/token" });
    expect(await screen.findByRole("header", { name: "Token not accepted" })).toBeTruthy();

    const field = screen.getByLabelText("New device token");
    expect(field.props).toMatchObject({ secureTextEntry: true, autoCorrect: false });
    await fireEvent.changeText(field, NEW_TOKEN);
    await fireEvent.press(screen.getByRole("button", { name: "Save and reconnect" }));

    expect(await screen.findByRole("header", { name: "No workout today" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
    expect(secure.items.get(TOKEN_KEY)).toBe(NEW_TOKEN);
    expect(calls.at(-1)?.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(rendered()).not.toContain(NEW_TOKEN);
    expect(rendered()).not.toContain(TOKEN);
  });

  it("keeps the token screen when the new token is rejected too", async () => {
    saved({ id: "alex", name: "Alex" });
    serve({ ...ok, "GET /v1/me": () => json(401, { error: "missing or invalid device token" }) });
    await renderRouter("./src/app", { initialUrl: "/connection/token" });

    await fireEvent.changeText(await screen.findByLabelText("New device token"), NEW_TOKEN);
    await fireEvent.press(screen.getByRole("button", { name: "Save and reconnect" }));

    expect(await screen.findByText(/wasn't accepted either/)).toBeTruthy();
    expect(screen.getByLabelText("New device token").props.value).toBe("");
    expect(rendered()).not.toContain(NEW_TOKEN);
  });

  it("hides the pending-sets card when nothing is waiting", async () => {
    saved({ id: "alex", name: "Alex" });
    await renderRouter("./src/app", { initialUrl: "/connection/unavailable" });

    expect(await screen.findByRole("header", { name: "Server unavailable" })).toBeTruthy();
    expect(screen.queryByTestId("pending-sets")).toBeNull();
    expect(screen.getByRole("button", { name: "Keep logging offline" })).toBeTruthy();
  });

  it("shows the pending-sets count from the offline queue", async () => {
    saved({ id: "alex", name: "Alex" });
    await twoPendingSets();
    serve({
      "GET /v1/health": () => new Response("Bad Gateway", { status: 502 }),
      "POST /v1/workout/sets": () => new Response("Bad Gateway", { status: 502 }),
    });
    await renderRouter("./src/app", { initialUrl: "/connection/unavailable" });

    expect(await screen.findByText("2 sets waiting to send")).toBeTruthy();
  });
});

describe("settings", () => {
  it("shows the connection with the token hidden and sets the unit per profile", async () => {
    saved({ id: "alex", name: "Alex" });
    await renderRouter("./src/app", { initialUrl: "/settings" });

    expect(await screen.findByText(SERVER)).toBeTruthy();
    expect(screen.getByText("Saved · hidden")).toBeTruthy();
    expect(screen.getByText("lb · set on this phone")).toBeTruthy();
    expect(screen.getByText("Use device setting")).toBeTruthy();
    expect(rendered()).not.toContain(TOKEN);

    await fireEvent.press(screen.getByRole("radio", { name: "Kilograms" }));

    expect(await screen.findByText("kg · set on this phone")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Kilograms" })).toBeChecked();
    expect(storedSettings().units).toEqual({ alex: "kg" });
  });

  it("opens the profile picker from Switch profile", async () => {
    saved({ id: "alex", name: "Alex" });
    const router = await renderRouter("./src/app", { initialUrl: "/settings" });

    await fireEvent.press(await screen.findByRole("button", { name: "Switch profile" }));

    expect(await screen.findByRole("header", { name: "Choose your profile" })).toBeTruthy();
    expect(router.getPathname()).toBe("/profile");
  });

  it("opens Replace device token", async () => {
    saved({ id: "alex", name: "Alex" });
    await renderRouter("./src/app", { initialUrl: "/settings" });

    await fireEvent.press(await screen.findByRole("button", { name: "Replace device token" }));

    expect(await screen.findByRole("header", { name: "Replace device token" })).toBeTruthy();
  });
});

describe("tap targets", () => {
  it("gives every button on setup a label and at least 48 dp", async () => {
    await renderRouter("./src/app");
    await screen.findByRole("header", { name: "Connect to Chotu" });

    for (const button of screen.getAllByRole("button")) {
      expect(button.props.accessibilityLabel).toBeTruthy();
      expect(button).toHaveStyle({ minWidth: 48 });
    }
  });

  it("does not fetch anything before the saved settings load", async () => {
    await renderRouter("./src/app");
    await waitFor(() => expect(screen.getByLabelText("Server address")).toBeTruthy());
    expect(calls).toHaveLength(0);
  });
});
