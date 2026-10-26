use super::*;
use crate::api::fixtures::{example, Examples};
use crate::api::workout::fixture_examples::{day, exercises};
use health_coach::{PlanDayKind, PlanExercise};

fn days() -> Vec<DayBody> {
    let monday = NaiveDate::from_ymd_opt(2026, 10, 26).unwrap();
    [
        ("Monday", PlanDayKind::Strength),
        ("Tuesday", PlanDayKind::Cardio),
        ("Wednesday", PlanDayKind::Rest),
        ("Thursday", PlanDayKind::Mixed),
        ("Friday", PlanDayKind::Strength),
        ("Saturday", PlanDayKind::Cardio),
        ("Sunday", PlanDayKind::Rest),
    ]
    .into_iter()
    .enumerate()
    .map(|(offset, (weekday, kind))| {
        day_body(
            PlanDay {
                weekday: weekday.into(),
                kind,
                notes: "Synthetic session".into(),
                exercises: if matches!(kind, PlanDayKind::Strength | PlanDayKind::Mixed) {
                    vec![PlanExercise {
                        name: "Example squat".into(),
                        sets: 3,
                        reps: "8-10".into(),
                    }]
                } else {
                    vec![]
                },
            },
            monday + Duration::days(offset as i64),
            monday,
        )
    })
    .collect()
}

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
                    days: days(),
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
