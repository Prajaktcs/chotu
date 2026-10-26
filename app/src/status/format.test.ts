import type { FitnessOutcome, StatusResponse } from "@/api";

import { countdown, dayOverline, goalAmount, hasActivity, nutrientAmount } from "./format";

const fitness = (days: number | null): FitnessOutcome => ({
  intent: "Run a 10k",
  target_date: days === null ? null : "2026-12-01",
  days_to_target: days,
  focus: "endurance",
});

describe("status text", () => {
  it("prints the server's rounded amounts with Signal's digits", () => {
    const row = { key: "protein", label: "Protein", unit: "g", sub: false };
    // Signal shows 121.25 g as 121.2 (ties to even); the server sends 121.2.
    expect(nutrientAmount({ ...row, amount: 121.2 })).toBe("121.2 g");
    expect(nutrientAmount({ ...row, amount: 61 })).toBe("61.0 g");
    expect(
      nutrientAmount({
        key: "calories",
        label: "Calories",
        amount: 1840,
        unit: "kcal",
        sub: false,
      }),
    ).toBe("1840 kcal");
  });

  it("names the unit of every goal, steps included", () => {
    expect(
      goalAmount({
        key: "calories",
        label: "Calories",
        actual: 1840,
        goal: 2200,
        percent: 84,
        unit: "kcal",
      }),
    ).toBe("1840 / 2200 kcal");
    expect(
      goalAmount({
        key: "steps",
        label: "Steps",
        actual: 8432,
        goal: 10000,
        percent: 84,
        unit: "",
      }),
    ).toBe("8432 / 10000 steps");
  });

  it("counts down to the fitness target like Signal", () => {
    expect(countdown(fitness(36))).toBe("36 days to target (2026-12-01)");
    expect(countdown(fitness(1))).toBe("1 day to target (2026-12-01)");
    expect(countdown(fitness(0))).toBe("Target day is today");
    expect(countdown(fitness(-3))).toBe("Target date 2026-12-01 was 3 days ago");
    expect(countdown(fitness(null))).toBeNull();
  });

  it("treats any synced metric or exercise as activity", () => {
    const empty: StatusResponse = {
      date: "2026-10-26",
      member: { id: "alex", name: "Alex" },
      activity: { steps: 0, active_calories: 0, sleep_hours: null, energy: null },
      exercises: [],
      fitness: null,
      nutrition: [],
      goals: [],
    };
    expect(hasActivity(empty)).toBe(false);
    expect(hasActivity({ ...empty, activity: { ...empty.activity, sleep_hours: 0 } })).toBe(true);
    expect(hasActivity({ ...empty, exercises: ["Walking (20 min)"] })).toBe(true);
  });

  it("dates the household day, not the phone's", () => {
    expect(dayOverline("2026-10-26")).toBe("MON, OCT 26");
  });
});
