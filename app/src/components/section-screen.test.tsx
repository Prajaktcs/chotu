import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Platform } from "react-native";

import { SectionScreen } from "./section-screen";

const mockMenu = { focus: jest.fn() };
const mockClose = { focus: jest.fn() };
let mockWidth = 400;
let mockDismiss: () => void;

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({ width: mockWidth, height: 800, scale: 1, fontScale: 1 }),
}));
jest.mock("./section-nav", () => ({ SectionList: () => null, SectionTabs: () => null }));
jest.mock("./app-bar", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Pressable } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    AppBar: ({ menuRef, onMenu }: import("./app-bar").AppBarProps) => {
      // Only the focus method is needed at this native ref boundary.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      React.useImperativeHandle(menuRef, () => mockMenu as never);
      return onMenu ? <Pressable accessibilityLabel="Menu" onPress={onMenu} /> : null;
    },
  };
});
jest.mock("./button", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Pressable } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Button: ({ ref, ...props }: import("./button").ButtonProps) => {
      // Only the focus method is needed at this native ref boundary.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      React.useImperativeHandle(ref, () => mockClose as never);
      return <Pressable {...props} />;
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWidth = 400;
});
afterEach(() => jest.restoreAllMocks());

it.each(["ios", "android", "web"] as const)("moves drawer focus on %s", async (os) => {
  jest.replaceProperty(Platform, "OS", os);
  const accessibility = jest
    .spyOn(AccessibilityInfo, "sendAccessibilityEvent")
    .mockImplementation(() => {});
  jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  await render(<SectionScreen screen="today">{null}</SectionScreen>);
  await fireEvent.press(screen.getByLabelText("Menu"));
  const modal = screen.getByTestId("section-navigation");
  // Retain the native dismissal callback: iOS calls it after visible becomes false.
  mockDismiss = modal.props.onDismiss;
  await fireEvent(modal, "show");
  if (os === "web") expect(mockClose.focus).toHaveBeenCalledTimes(1);
  else expect(accessibility).toHaveBeenCalledWith(mockClose, "focus");
  await fireEvent(modal, "requestClose");
  if (os === "ios") {
    expect(accessibility).not.toHaveBeenCalledWith(mockMenu, "focus");
    await act(async () => mockDismiss());
  }
  if (os === "web") expect(mockMenu.focus).toHaveBeenCalled();
  else expect(accessibility).toHaveBeenCalledWith(mockMenu, "focus");
});

it("does not restore an open drawer after resizing to a sidebar and back", async () => {
  const view = await render(<SectionScreen screen="today">{null}</SectionScreen>);
  await fireEvent.press(screen.getByLabelText("Menu"));
  expect(screen.getByLabelText("Close section navigation")).toBeTruthy();
  mockWidth = 1200;
  await view.rerender(<SectionScreen screen="today">{null}</SectionScreen>);
  expect(screen.queryByLabelText("Menu")).toBeNull();
  mockWidth = 400;
  await view.rerender(<SectionScreen screen="today">{null}</SectionScreen>);
  expect(screen.queryByLabelText("Close section navigation")).toBeNull();
});
