import {
  formatPounds,
  formatWeight,
  prefillWeight,
  stepWeightDown,
  stepWeightUp,
  toPounds,
  weightStep,
} from "./units";

describe("weight units", () => {
  it.each([
    [135, "lb", 135],
    [132.277357308, "lb", 132.5],
    [135, "kg", 61],
    [132.277357308, "kg", 60],
    [100, "kg", 45.5],
    [null, "lb", null],
    [null, "kg", null],
  ] as const)("pre-fills %s lb as %s in %s", (weightLb, unit, expected) => {
    expect(prefillWeight(weightLb, unit)).toBe(expected);
  });

  it("steps by 5 lb or 2.5 kg", () => {
    expect(weightStep("lb")).toBe(5);
    expect(weightStep("kg")).toBe(2.5);
    expect(stepWeightUp(135, "lb")).toBe(140);
    expect(stepWeightDown(135, "lb")).toBe(130);
    expect(stepWeightUp(60, "kg")).toBe(62.5);
    expect(stepWeightDown(60, "kg")).toBe(57.5);
  });

  it("snaps an off-step weight to the step grid", () => {
    expect(stepWeightUp(61, "kg")).toBe(62.5);
    expect(stepWeightDown(61, "kg")).toBe(60);
    expect(stepWeightUp(132.5, "lb")).toBe(135);
    expect(stepWeightDown(132.5, "lb")).toBe(130);
  });

  it("steps between bodyweight and the first step", () => {
    expect(stepWeightUp(null, "lb")).toBe(5);
    expect(stepWeightUp(null, "kg")).toBe(2.5);
    expect(stepWeightDown(5, "lb")).toBeNull();
    expect(stepWeightDown(2.5, "kg")).toBeNull();
    expect(stepWeightDown(null, "kg")).toBeNull();
  });

  it("stops at the server's limit", () => {
    expect(stepWeightUp(1500, "lb")).toBe(1500);
    expect(stepWeightUp(680, "kg")).toBe(680);
  });

  it("formats weights to one decimal at most", () => {
    expect(formatWeight(135, "lb")).toBe("135 lb");
    expect(formatWeight(61.25, "kg")).toBe("61.3 kg");
    expect(formatWeight(null, "kg")).toBe("Bodyweight");
    expect(formatPounds(132.277357308, "kg")).toBe("60 kg");
    expect(formatPounds(132.277357308, "lb")).toBe("132.3 lb");
    expect(toPounds(60, "kg")).toBeCloseTo(132.277357308, 6);
  });
});
