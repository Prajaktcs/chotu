use super::*;
use crate::api::fixtures::{example, Examples};

pub(in crate::api) fn media_config() -> AppConfig {
    AppConfig {
        exercise_media: [(
            "examplesquat".into(),
            chotu_common::family::ExerciseMediaConfig::Hosted {
                video_url: "https://example.invalid/synthetic.mp4".into(),
                poster_url: "https://example.invalid/synthetic.webp".into(),
                video_sha256: "a".repeat(64),
                poster_sha256: "b".repeat(64),
            },
        )]
        .into_iter()
        .collect(),
        ..AppConfig::default()
    }
}

pub(in crate::api) fn day() -> PlanDayBody {
    PlanDayBody {
        weekday: "Monday".into(),
        kind: "strength",
        notes: "Synthetic training day".into(),
    }
}

pub(in crate::api) fn exercises() -> Vec<PlannedExerciseBody> {
    planned_exercises(
        vec![
            PlanExercise {
                name: "Example squat".into(),
                sets: 3,
                reps: "8-10".into(),
            },
            PlanExercise {
                name: "Example push-up".into(),
                sets: 2,
                reps: "10".into(),
            },
            PlanExercise {
                name: "Bench press".into(),
                sets: 2,
                reps: "8".into(),
            },
        ],
        vec![
            Some(Target {
                weight_lb: Some(100.5),
                reps: vec![8, 8, 8],
                note: Some("Example progression".into()),
            }),
            Some(Target {
                weight_lb: None,
                reps: vec![10, 10],
                note: None,
            }),
            None,
        ],
        WeightUnit::Kg,
        &media_config(),
    )
}

fn set(weight_lb: Option<f64>, unit: WeightUnit) -> SetBody {
    let exercise_name = if weight_lb.is_some() {
        "Example squat"
    } else {
        "Example push-up"
    };
    SetBody::new(
        LoggedSet {
            id: "example-set".into(),
            exercise_key: exercise_name.replace([' ', '-'], "").to_lowercase(),
            exercise_name: exercise_name.into(),
            weight_lb,
            reps: 8,
        },
        unit,
        &media_config(),
    )
}

fn workout() -> WorkoutBody {
    WorkoutBody {
        session_id: "example-session".into(),
        current_exercise: Some("Example squat".into()),
        plan_day: Some(day()),
        exercises: exercises(),
        sets: vec![set(Some(100.5), WeightUnit::Kg), set(None, WeightUnit::Kg)],
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
                    sets: vec![set(None, WeightUnit::Lb)],
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
            "set-log-request-kg",
            LogSetRequest {
                exercise: "Example squat".into(),
                weight: Some(45.5),
                unit: Unit::Kg,
                reps: 8,
                performed_at: None,
            },
        ),
        example(
            "set-logged",
            SetLoggedResponse {
                set: set(Some(100.5), WeightUnit::Kg),
                workout: workout(),
            },
        ),
        example(
            "set-deleted",
            SetDeletedResponse {
                set: set(None, WeightUnit::Kg),
                workout: workout(),
            },
        ),
        example(
            "workout-done",
            WorkoutDoneResponse {
                exercises: vec![
                    SummaryBody::new(
                        ExerciseSummary {
                            name: "Example squat".into(),
                            sets: vec![(Some(100.5), 8)],
                            next: Some(Target {
                                weight_lb: Some(105.0),
                                reps: vec![8],
                                note: Some("Example next target".into()),
                            }),
                        },
                        WeightUnit::Kg,
                        &media_config(),
                    ),
                    SummaryBody::new(
                        ExerciseSummary {
                            name: "Example push-up".into(),
                            sets: vec![(None, 10)],
                            next: None,
                        },
                        WeightUnit::Kg,
                        &media_config(),
                    ),
                ],
            },
        ),
    ]
}
