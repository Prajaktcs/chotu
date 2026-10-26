// Hand-written mirrors of the coordinator's serde structs. Field names are the
// wire names (snake_case). Sources:
//   coordinator/src/api.rs          Health, Me, Profile, ErrorBody
//   coordinator/src/api/workout.rs  LogSetRequest and the workout bodies
// /v1 changes are additive only (docs/app-api.md), so a field here is never
// renamed or removed server-side without a 426 or a /v2.

/** `GET /v1/health` (no auth). */
export type Health = {
  status: "ok";
  /** Crate version plus git commit, e.g. `0.1.0+87dd739`. */
  server_version: string;
  /** The oldest `major.minor.patch` app the server accepts. */
  min_app_version: string;
};

export type Profile = {
  id: string;
  name: string;
};

/** `GET /v1/me`. */
export type Me = {
  device: string;
  /** The profile named by `X-Chotu-Member`, or null when none was sent. */
  member: Profile | null;
  /** Profiles this device may act as. */
  profiles: Profile[];
};

export type PlanDayKind = "rest" | "strength" | "cardio" | "mixed";

export type PlanDay = {
  weekday: string;
  kind: PlanDayKind;
  notes: string;
};

/** A prescription: the next target for a planned lift. */
export type Target = {
  /** Pounds; null is bodyweight. */
  weight_lb: number | null;
  /** Reps per set. */
  reps: number[];
  note: string | null;
};

export type PlannedExercise = {
  name: string;
  sets: number;
  /** The plan's rep range as written, e.g. `8-10`. */
  reps: string;
  target: Target | null;
};

export type LoggedSet = {
  id: string;
  exercise: string;
  /** Pounds, unrounded; null is bodyweight. */
  weight_lb: number | null;
  reps: number;
};

export type Workout = {
  session_id: string;
  current_exercise: string | null;
  /** Null without a weekly plan covering today. */
  plan_day: PlanDay | null;
  /** Empty on rest days and without a plan. */
  exercises: PlannedExercise[];
  /** Oldest first, including lifts outside the plan. */
  sets: LoggedSet[];
};

/**
 * Today's planned lifts with their next targets, sent by `GET /v1/workout`
 * before a workout is open.
 */
export type TodayPlan = {
  plan_day: PlanDay | null;
  /** Never empty: the server omits `plan` on rest days and without a plan. */
  exercises: PlannedExercise[];
};

/** `GET /v1/workout`. */
export type WorkoutResponse = {
  /** The household's day this answer is for, `2026-10-24`. Absent from older servers. */
  date?: string;
  workout: Workout | null;
  /**
   * Only while no workout is open and today has planned lifts. Reading it
   * opens nothing; the first logged set starts the workout.
   */
  plan?: TodayPlan;
};

export type WeightUnit = "lb" | "kg";

/** `POST /v1/workout/sets` body. */
export type LogSetRequest = {
  exercise: string;
  /** In `unit`; null is bodyweight. Required, even when null. */
  weight: number | null;
  unit: WeightUnit;
  /** 1-100. */
  reps: number;
  /** RFC 3339 with an offset. Server time when omitted. */
  performed_at?: string;
};

/** `POST /v1/workout/sets` (201). */
export type SetLoggedResponse = {
  set: LoggedSet;
  /** The workout the set joined; for an earlier set, possibly a closed one. */
  workout: Workout;
};

/** `DELETE /v1/workout/sets/{id}` (200). */
export type SetDeletedResponse = {
  set: LoggedSet;
  workout: Workout;
};

export type SetRecord = {
  weight_lb: number | null;
  reps: number;
};

export type ExerciseSummary = {
  name: string;
  sets: SetRecord[];
  next: Target | null;
};

/** `POST /v1/workout/done` (200). Exercises in first-logged order. */
export type WorkoutDoneResponse = {
  exercises: ExerciseSummary[];
};

/** Every error response body. */
export type ErrorBody = {
  error: string;
  /** Only on 426. */
  min_app_version?: string;
};
