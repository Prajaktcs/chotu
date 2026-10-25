// Type, spacing, radii and sizes from docs/app-design.md.

import type { TextStyle } from "react-native";

export type TypeRole = "display" | "headline" | "title" | "body" | "label";

// Roboto is Android's system font, so no fontFamily is set.
export const typography: Readonly<Record<TypeRole, TextStyle>> = {
  display: { fontSize: 40, fontWeight: "400" },
  headline: { fontSize: 30, fontWeight: "400" },
  title: { fontSize: 22, fontWeight: "400" },
  body: { fontSize: 16, fontWeight: "400" },
  label: { fontSize: 14, fontWeight: "400" },
};

/** Buttons use body at Medium; overlines use label at Medium, uppercase. */
export const fontWeightMedium = "500" satisfies TextStyle["fontWeight"];

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  /** Screen side padding. */
  screen: 24,
} as const;

export const radii = {
  /** Cards, text fields. */
  card: 12,
  /** Stepper panels, buttons. */
  panel: 20,
  /** The selected tab pill. */
  full: 9999,
} as const;

export const buttonHeights = {
  text: 48,
  secondary: 56,
  primary: 64,
} as const;

/** The smallest tap target, in dp. */
export const minTapTarget = 48;
