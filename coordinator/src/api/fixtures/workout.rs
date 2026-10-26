use super::*;
use crate::api::fixtures::{example, Examples};

pub(in crate::api) fn day() -> PlanDayBody {
    PlanDayBody {
        weekday: "Monday".into(),
        kind: "strength",
        notes: "Synthetic training day".into(),
    }
}

pub(in crate::api) fn exercises() -> Vec<PlannedExerciseBody> {
    vec![
        PlannedExerciseBody {
            name: "Example squat".into(),
            sets: 3,
            reps: "8-10".into(),
            target: Some(TargetBody {
                weight_lb: Some(100.5),
                reps: vec![8, 8, 8],
                note: Some("Example progression".into()),
            }),
        },
        PlannedExerciseBody {
            name: "Example push-up".into(),
            sets: 2,
            reps: "10".into(),
            target: Some(TargetBody {
                weight_lb: None,
                reps: vec![10, 10],
                note: None,
            }),
        },
        PlannedExerciseBody {
            name: "Example row".into(),
            sets: 2,
            reps: "8".into(),
            target: None,
        },
    ]
}

fn set(weight_lb: Option<f64>) -> SetBody {
    SetBody {
        id: "example-set".into(),
        exercise: "Example squat".into(),
        weight_lb,
        reps: 8,
    }
}

fn workout() -> WorkoutBody {
    WorkoutBody {
        session_id: "example-session".into(),
        current_exercise: Some("Example squat".into()),
        plan_day: Some(day()),
        exercises: exercises(),
        sets: vec![set(Some(100.5)), set(None)],
    }
}

pub(in crate::api) fn examples() -> Examples {
    vec![
        example(
            "workout-before",
            WorkoutResponse {
                date: "2026-10-26".into(),
                workout: None,
                plan: Some(PlanBody {
                    plan_day: Some(day()),
                    exercises: exercises(),
                }),
            },
        ),
        example(
            "workout-open",
            WorkoutResponse {
                date: "2026-10-26".into(),
                workout: Some(workout()),
                plan: None,
            },
        ),
        example(
            "workout-no-plan",
            WorkoutResponse {
                date: "2026-10-26".into(),
                workout: None,
                plan: None,
            },
        ),
        example(
            "workout-unplanned",
            WorkoutResponse {
                date: "2026-10-26".into(),
                workout: Some(WorkoutBody {
                    session_id: "example-session".into(),
                    current_exercise: None,
                    plan_day: None,
                    exercises: vec![],
                    sets: vec![set(None)],
                }),
                plan: None,
            },
        ),
        example(
            "set-log-request",
            LogSetRequest {
                exercise: "Example squat".into(),
                weight: Some(100.5),
                unit: Unit::Lb,
                reps: 8,
                performed_at: Some("2026-10-26T10:00:00Z".into()),
            },
        ),
        example(
            "set-log-request-bodyweight",
            LogSetRequest {
                exercise: "Example push-up".into(),
                weight: None,
                unit: Unit::Kg,
                reps: 10,
                performed_at: None,
            },
        ),
        example(
            "set-logged",
            SetLoggedResponse {
                set: set(Some(100.5)),
                workout: workout(),
            },
        ),
        example(
            "set-deleted",
            SetDeletedResponse {
                set: set(None),
                workout: workout(),
            },
        ),
        example(
            "workout-done",
            WorkoutDoneResponse {
                exercises: vec![
                    SummaryBody {
                        name: "Example squat".into(),
                        sets: vec![SetRecordBody {
                            weight_lb: Some(100.5),
                            reps: 8,
                        }],
                        next: Some(TargetBody {
                            weight_lb: Some(105.0),
                            reps: vec![8],
                            note: Some("Example next target".into()),
                        }),
                    },
                    SummaryBody {
                        name: "Example push-up".into(),
                        sets: vec![SetRecordBody {
                            weight_lb: None,
                            reps: 10,
                        }],
                        next: None,
                    },
                ],
            },
        ),
    ]
}
