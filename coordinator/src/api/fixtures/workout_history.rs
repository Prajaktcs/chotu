use super::*;
use crate::api::fixtures::{example, Examples};

fn d(raw: &str) -> NaiveDate {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").unwrap()
}

fn set(id: &str, name: &str, weight_lb: Option<f64>, reps: u32, at: &str) -> HistorySet {
    HistorySet {
        id: id.into(),
        exercise_name: name.into(),
        weight_lb,
        reps,
        performed_at: chrono::NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S").unwrap(),
    }
}

pub(in crate::api) fn examples() -> Examples {
    let page = HistoryPage {
        workouts: vec![
            HistoryWorkout {
                session_id: "example-session-2".into(),
                date: d("2026-10-26"),
                closed: false,
                sets: vec![
                    set(
                        "example-set-3",
                        "Example squat",
                        Some(100.5),
                        8,
                        "2026-10-26 13:05:00",
                    ),
                    set(
                        "example-set-4",
                        "Example push-up",
                        None,
                        12,
                        "2026-10-26 13:12:00",
                    ),
                ],
            },
            HistoryWorkout {
                session_id: "example-session-1".into(),
                date: d("2026-10-23"),
                closed: true,
                sets: vec![
                    set(
                        "example-set-1",
                        "Example squat",
                        Some(95.0),
                        8,
                        "2026-10-23 13:05:00",
                    ),
                    set(
                        "example-set-2",
                        "Example squat",
                        Some(95.0),
                        7,
                        "2026-10-23 13:08:00",
                    ),
                ],
            },
        ],
        next_before: Some(d("2026-10-23")),
    };
    let point = |date: &str, weight: Option<f64>, reps: Vec<u32>| TrendPoint {
        date: d(date),
        top_weight_lb: weight,
        sets: reps.len() as u32,
        reps,
    };
    let trends = FitnessTrends {
        from: d("2026-10-19"),
        to: d("2026-10-26"),
        workout_days: 2,
        sets: 4,
        weeks: vec![
            WeekVolume {
                week_start: d("2026-10-19"),
                workout_days: 1,
                sets: 2,
            },
            WeekVolume {
                week_start: d("2026-10-26"),
                workout_days: 1,
                sets: 2,
            },
        ],
        exercises: vec![
            ExerciseTrend {
                name: "Example squat".into(),
                points: vec![
                    point("2026-10-23", Some(95.0), vec![8, 7]),
                    point("2026-10-26", Some(100.5), vec![8]),
                ],
            },
            ExerciseTrend {
                name: "Example push-up".into(),
                points: vec![point("2026-10-26", None, vec![12])],
            },
        ],
    };
    vec![
        example(
            "workout-history",
            HistoryResponse::new(page, WeightUnit::Lb),
        ),
        example(
            "workout-history-empty",
            HistoryResponse::new(
                HistoryPage {
                    workouts: Vec::new(),
                    next_before: None,
                },
                WeightUnit::Lb,
            ),
        ),
        example(
            "workout-trends",
            TrendsResponse::new(trends, WeightUnit::Lb),
        ),
    ]
}
