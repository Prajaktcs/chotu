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
            },
        ),
        example(
            "food-day-empty",
            FoodDayResponse {
                date: "2026-10-27".into(),
                meals: vec![],
            },
        ),
        example(
            "food-add-request",
            AddMealRequest {
                description: "Synthetic lunch bowl".into(),
                date: "2026-10-27".into(),
            },
        ),
        example(
            "food-edit-request",
            EditMealRequest {
                description: "Synthetic dinner plate, half portion".into(),
                revision: 2,
            },
        ),
    ]
}
