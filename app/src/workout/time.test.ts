import { formatClock, planDayName, toLocalRfc3339, workoutOverline } from "./time";

describe("toLocalRfc3339", () => {
  it("writes the local time with its offset, to the second", () => {
    const tapped = new Date(2026, 9, 24, 18, 5, 7, 450);

    const text = toLocalRfc3339(tapped);

    expect(text).toMatch(/^2026-10-24T18:05:07[+-]\d{2}:\d{2}$/);
    // The same instant, without the milliseconds.
    expect(Date.parse(text)).toBe(Math.floor(tapped.getTime() / 1000) * 1000);
  });

  it("formats the clock time of a queued set", () => {
    expect(formatClock(toLocalRfc3339(new Date(2026, 9, 24, 9, 32)))).toBe("9:32");
    expect(formatClock(toLocalRfc3339(new Date(2026, 9, 24, 21, 5)))).toBe("9:05");
    expect(formatClock("not a time")).toBe("");
  });
});

describe("workout overline", () => {
  it("shows the date and the plan day", () => {
    const day = { weekday: "Saturday", kind: "strength", notes: "Upper body" } as const;
    expect(workoutOverline(new Date(2026, 9, 24), day)).toBe("SAT, OCT 24 · Upper body");
    expect(workoutOverline(new Date(2026, 9, 24), null)).toBe("SAT, OCT 24");
    expect(planDayName({ ...day, notes: " " })).toBe("Strength");
  });
});
