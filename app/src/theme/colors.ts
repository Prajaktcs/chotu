// Colour tokens from docs/app-design.md. Keep the two in sync; contrast.test.ts
// checks every text/background pair for WCAG 4.5:1.

export type ColorToken =
  | "background"
  | "surface"
  | "container"
  | "text"
  | "muted"
  | "outline"
  | "primary"
  | "onPrimary"
  | "pending"
  | "pendingContainer"
  | "error"
  | "errorContainer";

export type Palette = Readonly<Record<ColorToken, string>>;

export type ColorScheme = "light" | "dark";

export const palettes: Readonly<Record<ColorScheme, Palette>> = {
  light: {
    background: "#F8FAF8",
    surface: "#FFFFFF",
    container: "#EAF0EA",
    text: "#17221A",
    muted: "#4D5D51",
    outline: "#B8C5B9",
    primary: "#28633C",
    onPrimary: "#FFFFFF",
    pending: "#705200",
    pendingContainer: "#FFF3CE",
    error: "#A52B26",
    errorContainer: "#FCEBE8",
  },
  dark: {
    background: "#111512",
    surface: "#1A201B",
    container: "#242D26",
    text: "#E2EAE1",
    muted: "#B8C6B9",
    outline: "#536256",
    primary: "#9DD5A8",
    onPrimary: "#003915",
    pending: "#F0C048",
    pendingContainer: "#3A2C00",
    error: "#FFB4AB",
    errorContainer: "#5C1612",
  },
};
