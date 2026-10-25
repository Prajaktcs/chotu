import { fireEvent, render, screen } from "@testing-library/react-native";

import { Button } from "./button";

describe("Button", () => {
  it("calls onPress and exposes its label to screen readers", async () => {
    const onPress = jest.fn();
    await render(
      <Button label="Log set" accessibilityLabel="Log set at target" onPress={onPress} />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Log set at target" }));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Log set")).toBeTruthy();
  });

  it.each([
    ["primary", 64],
    ["secondary", 56],
    ["danger", 56],
    ["text", 48],
  ] as const)("%s is at least %i dp tall", async (variant, height) => {
    await render(
      <Button label="Go" accessibilityLabel="Go" onPress={jest.fn()} variant={variant} />,
    );

    expect(screen.getByRole("button")).toHaveStyle({ minHeight: height, minWidth: 48 });
  });

  it("does not fire when disabled", async () => {
    const onPress = jest.fn();
    await render(<Button label="Done" accessibilityLabel="Done" onPress={onPress} disabled />);

    await fireEvent.press(screen.getByRole("button"));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
