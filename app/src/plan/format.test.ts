import { kindLabel, prescription, progressLines, shortDate, targetText } from "./format";

describe("plan text", () => {
  it("writes sets and reps for the same cases as Signal's /plan", () => {
    // Signal: `Leg press — 3×10-12`, `Easy run — 30 min easy`, `Rows — 3 sets`, `Walk`.
    expect(prescription({ sets: 3, reps: "10-12" })).toBe("3 × 10-12");
    expect(prescription({ sets: 1, reps: "30 min easy" })).toBe("30 min easy");
    expect(prescription({ sets: 0, reps: " 45s " })).toBe("45s");
    expect(prescription({ sets: 3, reps: "" })).toBe("3 sets");
    expect(prescription({ sets: 1, reps: "" })).toBe("");
  });

  it("states the next target with Signal's numbers, in the profile's unit", () => {
    const target = { weight_lb: 190, reps: [10, 10, 10], note: "+10 lb" };
    // Signal: ` @ 190 lb, aim 10/10/10 (+10 lb)`.
    expect(targetText(target, "lb")).toBe("190 lb · aim 10/10/10 · +10 lb");
    expect(targetText({ ...target, note: null }, "kg")).toBe("86.2 kg · aim 10/10/10");
    expect(targetText({ weight_lb: null, reps: [12, 12], note: null }, "lb")).toBe("aim 12/12");
    expect(targetText({ weight_lb: null, reps: [], note: "first time: pick a weight" }, "lb")).toBe(
      "first time: pick a weight",
    );
    expect(targetText(null, "lb")).toBeNull();
  });

  it("splits Signal's progress line into facts", () => {
    // Signal: `2/3 sessions matched · 30 min cardio logged · 30 min on planned cardio/mixed days`.
    expect(
      progressLines({
        sessions_matched: 2,
        sessions_planned: 3,
        cardio_minutes: 30,
        planned_cardio_minutes: 30,
      }),
    ).toEqual([
      "2 of 3 planned sessions done",
      "30 min cardio logged",
      "30 min on planned cardio or mixed days",
    ]);
    expect(
      progressLines({
        sessions_matched: 0,
        sessions_planned: 0,
        cardio_minutes: 0,
        planned_cardio_minutes: 0,
      }),
    ).toEqual(["No sessions planned yet this week", "0 min cardio logged"]);
  });

  it("labels days", () => {
    expect(kindLabel("strength")).toBe("Strength");
    expect(shortDate("2026-10-26")).toBe("Mon, Oct 26");
  });
});
