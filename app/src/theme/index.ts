import { useColorScheme } from "react-native";

import { type ColorScheme, type Palette, palettes } from "./colors";
import { buttonHeights, minTapTarget, radii, spacing, typography } from "./tokens";

export type { ColorScheme, ColorToken, Palette } from "./colors";
export type { TypeRole } from "./tokens";
export { palettes } from "./colors";
export {
  buttonHeights,
  fontWeightMedium,
  minTapTarget,
  radii,
  spacing,
  typography,
} from "./tokens";

export type Theme = {
  scheme: ColorScheme;
  colors: Palette;
  typography: typeof typography;
  spacing: typeof spacing;
  radii: typeof radii;
  buttonHeights: typeof buttonHeights;
  minTapTarget: typeof minTapTarget;
};

const themes: Readonly<Record<ColorScheme, Theme>> = {
  light: {
    scheme: "light",
    colors: palettes.light,
    typography,
    spacing,
    radii,
    buttonHeights,
    minTapTarget,
  },
  dark: {
    scheme: "dark",
    colors: palettes.dark,
    typography,
    spacing,
    radii,
    buttonHeights,
    minTapTarget,
  },
};

/** The theme for the device's colour scheme (light unless it says dark). */
export function useTheme(): Theme {
  return useColorScheme() === "dark" ? themes.dark : themes.light;
}
