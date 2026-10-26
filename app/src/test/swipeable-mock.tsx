import { type ReactNode, type Ref, useImperativeHandle } from "react";
import { View } from "react-native";
import type {
  SwipeableMethods,
  SwipeableProps,
} from "react-native-gesture-handler/ReanimatedSwipeable";

export const SwipeDirection = { LEFT: "left", RIGHT: "right" } as const;

const noop = () => undefined;

/** ReanimatedSwipeable for Jest: renders the row, and `swipeableOpen` calls onSwipeableOpen. */
export default function SwipeableMock({
  ref,
  testID,
  children,
  onSwipeableOpen,
}: SwipeableProps & { ref?: Ref<SwipeableMethods>; children?: ReactNode }) {
  useImperativeHandle(ref, () => ({ close: noop, openLeft: noop, openRight: noop, reset: noop }));
  return (
    <View testID={testID} {...{ onSwipeableOpen }}>
      {children}
    </View>
  );
}
