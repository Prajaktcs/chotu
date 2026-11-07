use super::*;
use crate::api::fixtures::{example, Examples};

fn conditions(watchlist: Vec<String>) -> ConditionsResponse {
    ConditionsResponse {
        conditions: vec![ConditionBody {
            id: "skin".into(),
            label: "Synthetic skin symptoms".into(),
            check_in: true,
            lag_window: [1, 3],
            notes: Some("Synthetic member note".into()),
            watchlist,
        }],
        tags: vec![
            TagBody {
                tag: "dairy".into(),
                label: "Dairy".into(),
                description: "milk, cheese, paneer, yogurt".into(),
            },
            TagBody {
                tag: "alcohol".into(),
                label: "Alcohol".into(),
                description: "beer, wine, spirits".into(),
            },
        ],
    }
}

fn day(date: &str, score: Option<i32>, hits: &[&str]) -> TrendDayBody {
    TrendDayBody {
        date: date.into(),
        score,
        sleep_hours: score.map(|_| 7.5),
        watch_hits: hits.iter().map(|tag| tag.to_string()).collect(),
        food_covered: !hits.is_empty(),
    }
}

pub(in crate::api) fn examples() -> Examples {
    vec![
        example("health-conditions", conditions(vec!["dairy".into()])),
        example(
            "health-conditions-none",
            ConditionsResponse {
                conditions: vec![],
                tags: vec![],
            },
        ),
        example(
            "health-checkins",
            CheckinsResponse {
                today: "2026-10-27".into(),
                from: "2026-10-21".into(),
                to: "2026-10-27".into(),
                checkins: vec![
                    CheckinBody {
                        date: "2026-10-25".into(),
                        condition_id: "skin".into(),
                        score: 2,
                        note: Some("synthetic itch".into()),
                    },
                    CheckinBody {
                        date: "2026-10-27".into(),
                        condition_id: "skin".into(),
                        score: 0,
                        note: None,
                    },
                ],
            },
        ),
        example(
            "health-checkin-request",
            CheckinRequest {
                score: 3,
                note: Some("synthetic note".into()),
            },
        ),
        example(
            "health-trends",
            TrendsResponse {
                from: "2026-10-21".into(),
                to: "2026-10-27".into(),
                days: 7,
                thresholds: ThresholdsBody {
                    timeline_checkins: 7,
                    comparison_pairs: 10,
                    sleep_caliper_hours: 0.5,
                },
                conditions: vec![TrendBody {
                    id: "skin".into(),
                    label: "Synthetic skin symptoms".into(),
                    lag_window: [1, 3],
                    watchlist: vec!["dairy".into()],
                    checkins: 2,
                    days: vec![
                        day("2026-10-25", Some(2), &["dairy"]),
                        day("2026-10-26", None, &[]),
                        day("2026-10-27", Some(0), &[]),
                    ],
                    comparisons: vec![ComparisonBody {
                        tag: "dairy".into(),
                        difference: 1.25,
                        pairs: 10,
                    }],
                }],
            },
        ),
    ]
}
