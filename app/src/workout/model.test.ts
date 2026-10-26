import type { PlannedExercise, WorkoutResponse } from "@/api";

import {
  canonicalExercise,
  isAnswerCurrent,
  mergeSets,
  nextSet,
  offPlanExercises,
  planSummary,
  rowsFor,
  sameExercise,
} from "./model";
import type { QueuedSet } from "./queue/set-queue";

const bench: PlannedExercise = {
  name: "Bench press",
  sets: 3,
  reps: "8-10",
  target: { weight_lb: 135, reps: [9, 9, 8], note: null },
};

const queued = (overrides: Partial<QueuedSet> = {}): QueuedSet => ({
  requestId: "r1",
  exercise: "Bench press",
  weight: 60,
  unit: "kg",
  reps: 8,
  performedAt: "2026-10-24T09:32:00-04:00",
  status: "pending",
  ...overrides,
});

describe("nextSet", () => {
  it("uses the target for the next set's index, in the profile's unit", () => {
    expect(nextSet(bench, [], "lb")).toEqual({ weight: 135, reps: 9 });
    expect(nextSet(bench, [], "kg")).toEqual({ weight: 61, reps: 9 });

    const rows = mergeSets(
      [
        { id: "a", exercise: "Bench press", weight_lb: 135, reps: 9 },
        { id: "b", exercise: "Bench press", weight_lb: 135, reps: 9 },
      ],
      [],
      "lb",
    );
    expect(nextSet(bench, rows, "lb")).toEqual({ weight: 135, reps: 8 });
  });

  it("counts pending sets but not failed ones", () => {
    const rows = mergeSets(
      [],
      [queued({ requestId: "p" }), queued({ requestId: "f", status: "failed" })],
      "lb",
    );
    expect(nextSet(bench, rows, "lb").reps).toBe(9);
  });

  it("falls back to the last set logged, then the plan's lower bound", () => {
    const afterTargets = mergeSets(
      [1, 2, 3].map((n) => ({ id: `s${n}`, exercise: "Bench press", weight_lb: 135, reps: 7 })),
      [],
      "lb",
    );
    expect(nextSet(bench, afterTargets, "lb")).toEqual({ weight: 135, reps: 7 });

    const noTarget = { ...bench, target: null };
    expect(nextSet(noTarget, [], "lb")).toEqual({ weight: null, reps: 8 });
    const logged = mergeSets(
      [{ id: "s", exercise: "Bench press", weight_lb: 100, reps: 12 }],
      [],
      "kg",
    );
    expect(nextSet(noTarget, logged, "kg")).toEqual({ weight: 45.5, reps: 12 });
  });

  it("keeps bodyweight targets as bodyweight", () => {
    const pullups: PlannedExercise = {
      name: "Pull-ups",
      sets: 3,
      reps: "6-8",
      target: { weight_lb: null, reps: [6, 6, 6], note: null },
    };
    expect(nextSet(pullups, [], "kg")).toEqual({ weight: null, reps: 6 });
    expect(planSummary(pullups, "kg")).toBe("3 sets · next target Bodyweight × 6");
    expect(planSummary(bench, "lb")).toBe("3 sets · next target 135 lb × 9");
  });

  it("defaults an unknown lift to bodyweight × 8", () => {
    expect(nextSet(null, [], "lb")).toEqual({ weight: null, reps: 8 });
  });
});

describe("mergeSets", () => {
  it("lists saved sets, then queued ones, hiding sets being undone", () => {
    const rows = mergeSets(
      [
        { id: "a", exercise: "Bench press", weight_lb: 135, reps: 9 },
        { id: "b", exercise: "Squat", weight_lb: 225, reps: 5 },
      ],
      [queued(), queued({ requestId: "r2", status: "failed", reason: "too old" })],
      "lb",
      new Set(["b"]),
    );

    expect(rows.map((row) => [row.key, row.label, row.state, row.reason])).toEqual([
      ["saved:a", "135 lb × 9", "saved", null],
      ["queued:r1", "60 kg × 8", "pending", null],
      ["queued:r2", "60 kg × 8", "failed", "too old"],
    ]);
    expect(rowsFor(rows, "bench press")).toHaveLength(3);
    expect(rowsFor(rows, null)).toEqual([]);
  });

  it("finds lifts outside the plan", () => {
    const rows = mergeSets(
      [{ id: "a", exercise: "Face pulls", weight_lb: 30, reps: 15 }],
      [queued(), queued({ requestId: "r2", exercise: "face pulls" })],
      "lb",
    );
    const workout = {
      session_id: "s",
      current_exercise: null,
      plan_day: null,
      exercises: [bench],
      sets: [],
    };
    expect(offPlanExercises(workout, rows)).toEqual(["Face pulls"]);
  });
});

describe("canonicalExercise", () => {
  const plan = [{ name: "Bench press" }, { name: "Incline bench press" }, { name: "Pull-ups" }];

  it("matches the server: key equality, then a unique word prefix", () => {
    expect(canonicalExercise(plan, "pullups")).toBe("Pull-ups");
    expect(canonicalExercise(plan, " bench press ")).toBe("Bench press");
    expect(canonicalExercise(plan, "incl")).toBe("Incline bench press");
    // Two lifts start with "bench": not unique, so it's a new lift.
    expect(canonicalExercise(plan, "bench")).toBe("Bench");
    expect(canonicalExercise([{ name: "Bench press" }], "bench")).toBe("Bench press");
    expect(canonicalExercise(plan, "deadlift")).toBe("Deadlift");
  });

  it("treats punctuation and case as the same lift", () => {
    expect(sameExercise("Pull-ups", "pullups")).toBe(true);
    expect(sameExercise("Bench press", "bench")).toBe(false);
  });
});

describe("isAnswerCurrent", () => {
  const loaded = new Date(2026, 9, 24, 23, 0).getTime();
  const nextMorning = new Date(2026, 9, 25, 7, 0);
  const sameEvening = new Date(2026, 9, 24, 23, 30);
  const open: WorkoutResponse = {
    workout: { session_id: "s1", current_exercise: null, plan_day: null, exercises: [], sets: [] },
  };

  it("keeps an open workout past midnight", () => {
    expect(isAnswerCurrent(open, loaded, nextMorning)).toBe(true);
  });

  it("holds a plan, or no workout, only for the day it was loaded", () => {
    const plan: WorkoutResponse = { date: "2026-10-24", workout: null };
    expect(isAnswerCurrent(plan, loaded, sameEvening)).toBe(true);
    expect(isAnswerCurrent(plan, loaded, nextMorning)).toBe(false);
  });
});
