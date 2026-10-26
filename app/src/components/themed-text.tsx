import { Text, type TextProps } from "react-native";

import { type ColorToken, type TypeRole, fontWeightMedium, useTheme } from "@/theme";

export type ThemedTextProps = TextProps & {
  /** A type role, or `overline`: label size, Medium, uppercase. */
  variant?: TypeRole | "overline";
  color?: ColorToken;
  medium?: boolean;
};

/** Text in a type role and a colour token. Defaults to body in `text`. */
export function ThemedText({
  variant = "body",
  color = "text",
  medium = false,
  style,
  ...rest
}: ThemedTextProps) {
  const theme = useTheme();
  const overline = variant === "overline";
  return (
    <Text
      style={[
        theme.typography[overline ? "label" : variant],
        { color: theme.colors[color] },
        (medium || overline) && { fontWeight: fontWeightMedium },
        overline && { textTransform: "uppercase" },
        style,
      ]}
      {...rest}
    />
  );
}
