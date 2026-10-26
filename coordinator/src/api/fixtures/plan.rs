use super::*;
use crate::api::fixtures::{example, Examples};
use crate::api::workout::fixture_examples::{day, exercises};

pub(in crate::api) fn examples() -> Examples {
    let mut examples = vec![
        example(
            "plan",
            PlanResponse {
                date: "2026-10-26".into(),
                week_start: "2026-10-26".into(),
                reason: None,
                plan: Some(PlanBody {
                    theme: "Synthetic training week".into(),
                    days: vec![DayBody {
                        date: "2026-10-26".into(),
                        weekday: "Monday".into(),
                        kind: "strength",
                        notes: "Example session".into(),
                        is_today: true,
                        exercises: vec![ExerciseBody {
                            name: "Example squat".into(),
                            sets: 3,
                            reps: "8-10".into(),
                        }],
                    }],
                    today: Some(TodayBody {
                        day: day(),
                        exercises: exercises(),
                    }),
                    progress: Some(ProgressBody {
                        sessions_matched: 1,
                        sessions_planned: 3,
                        cardio_minutes: 20,
                        planned_cardio_minutes: 60,
                    }),
                }),
            },
        ),
        example(
            "plan-nullable",
            PlanResponse {
                date: "2026-10-26".into(),
                week_start: "2026-10-26".into(),
                reason: None,
                plan: Some(PlanBody {
                    theme: "Synthetic training week".into(),
                    days: vec![],
                    today: None,
                    progress: None,
                }),
            },
        ),
    ];
    for (name, reason) in [
        ("plan-no-goals", "no_fitness_goals"),
        ("plan-not-generated", "not_generated"),
        ("plan-unreadable", "unreadable"),
    ] {
        examples.push(example(
            name,
            PlanResponse {
                date: "2026-10-26".into(),
                week_start: "2026-10-26".into(),
                plan: None,
                reason: Some(reason),
            },
        ));
    }
    examples
}
