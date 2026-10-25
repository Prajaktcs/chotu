import { type ColorScheme, type ColorToken, palettes } from "./colors";

// WCAG 2.x relative luminance of a #RRGGBB colour.
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const pairs: [foreground: ColorToken, background: ColorToken][] = [
  ...(["text", "muted", "primary"] as const).flatMap((fg) =>
    (["background", "surface", "container"] as const).map((bg): [ColorToken, ColorToken] => [
      fg,
      bg,
    ]),
  ),
  ["onPrimary", "primary"],
  ["pending", "pendingContainer"],
  ["error", "errorContainer"],
];

const cases = (["light", "dark"] as ColorScheme[]).flatMap((scheme) =>
  pairs.map(([fg, bg]) => [scheme, fg, bg] as const),
);

describe("colour tokens", () => {
  it.each(cases)("%s %s on %s is at least 4.5:1", (scheme, fg, bg) => {
    const palette = palettes[scheme];
    expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it("uses #RRGGBB values", () => {
    for (const palette of Object.values(palettes)) {
      for (const value of Object.values(palette)) {
        expect(value).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it("computes known ratios", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});
