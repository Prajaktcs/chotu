use super::*;
use crate::api::fixtures::{example, Examples};

fn meal(id: &str, revision: i64, eaten_at: &str, description: &str) -> MealBody {
    MealBody::from(MealRow {
        id: id.into(),
        revision,
        timestamp: eaten_at.parse().unwrap(),
        raw_text_description: description.into(),
        estimated_calories: 420,
        estimated_protein: 24.5,
        estimated_carbs: 38.0,
        estimated_fats: 17.25,
    })
}

pub(in crate::api) fn examples() -> Examples {
    vec![
        example(
            "food-day",
            FoodDayResponse {
                date: "2026-10-27".into(),
                meals: vec![
                    meal(
                        "example-meal-1",
                        0,
                        "2026-10-27T12:30:00Z",
                        "Synthetic lunch bowl",
                    ),
                    meal(
                        "example-meal-2",
                        2,
                        "2026-10-27T19:15:00Z",
                        "Synthetic dinner plate",
                    ),
                ],
                watchlist_flags: vec![],
            },
        ),
        example(
            "food-day-empty",
            FoodDayResponse {
                date: "2026-10-27".into(),
                meals: vec![],
                watchlist_flags: vec![],
            },
        ),
        example(
            "food-add-request",
            AddMealRequest {
                description: "Synthetic lunch bowl".into(),
                date: "2026-10-27".into(),
                photo: None,
            },
        ),
        example(
            "food-add-photo-request",
            AddMealRequest {
                description: "half the bowl".into(),
                date: "2026-10-27".into(),
                photo: Some(MealPhoto {
                    content_type: "image/jpeg".into(),
                    data: "c3ludGhldGlj".into(),
                }),
            },
        ),
        example(
            "food-edit-request",
            EditMealRequest {
                description: "Synthetic dinner plate, half portion".into(),
                revision: 2,
            },
        ),
        example(
            "food-correct-request",
            CorrectMealRequest {
                revision: 2,
                correction: "paneer, not eggs; half the bowl".into(),
                photo: None,
            },
        ),
        example(
            "food-correct-photo-request",
            CorrectMealRequest {
                revision: 2,
                correction: String::new(),
                photo: Some(MealPhoto {
                    content_type: "image/jpeg".into(),
                    data: "c3ludGhldGlj".into(),
                }),
            },
        ),
        example(
            "food-corrected",
            CorrectMealResponse::Updated {
                day: FoodDayResponse {
                    date: "2026-10-27".into(),
                    watchlist_flags: vec![WatchlistFlagBody {
                        condition: "Synthetic skin symptoms".into(),
                        tags: vec!["dairy".into()],
                    }],
                    meals: vec![meal(
                        "example-meal-2",
                        3,
                        "2026-10-27T19:15:00Z",
                        "Synthetic paneer bowl, half portion",
                    )],
                },
                remote: Some(RemoteSync::Pending),
            },
        ),
        example(
            "food-corrected-local",
            CorrectMealResponse::Updated {
                day: FoodDayResponse {
                    date: "2026-10-27".into(),
                    meals: vec![],
                    watchlist_flags: vec![],
                },
                remote: None,
            },
        ),
        example(
            "food-correct-clarify",
            CorrectMealResponse::Clarify {
                question: "Which part of the meal is paneer?".into(),
            },
        ),
        example(
            "food-clear-request",
            ClearDayRequest {
                date: "2026-10-27".into(),
            },
        ),
        example(
            "food-adjust-request",
            AdjustDayRequest {
                date: "2026-10-27".into(),
                calories: 2000,
                protein_g: 150.0,
                carbs_g: 200.0,
                fat_g: 60.5,
            },
        ),
        example(
            "food-trends",
            FoodTrendsResponse {
                from: "2026-10-21".into(),
                to: "2026-10-27".into(),
                days: 7,
                goals: GoalsBody {
                    calories: Some(2200),
                    protein_g: Some(150.0),
                    carbs_g: None,
                    fat_g: None,
                    fiber_g: Some(30.0),
                },
                summaries: vec![
                    DaySummaryBody {
                        date: "2026-10-25".into(),
                        calories: 1840,
                        protein_g: 121.2,
                        carbs_g: 180.0,
                        fat_g: 61.0,
                        fiber_g: 22.5,
                    },
                    DaySummaryBody {
                        date: "2026-10-27".into(),
                        calories: 2310,
                        protein_g: 160.0,
                        carbs_g: 240.5,
                        fat_g: 70.0,
                        fiber_g: 31.0,
                    },
                ],
            },
        ),
        example(
            "food-trends-no-goals",
            FoodTrendsResponse {
                from: "2026-10-21".into(),
                to: "2026-10-27".into(),
                days: 7,
                goals: GoalsBody {
                    calories: None,
                    protein_g: None,
                    carbs_g: None,
                    fat_g: None,
                    fiber_g: None,
                },
                summaries: Vec::new(),
            },
        ),
    ]
}
