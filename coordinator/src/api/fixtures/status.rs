use super::*;
use crate::api::fixtures::{example, Examples};

fn member() -> MemberBody {
    MemberBody {
        id: "example-member".into(),
        name: "Example Member".into(),
    }
}

pub(in crate::api) fn examples() -> Examples {
    vec![
        example(
            "status",
            StatusResponse {
                date: "2026-10-26".into(),
                member: member(),
                activity: ActivityBody {
                    steps: 5000,
                    active_calories: 250,
                    sleep_hours: Some(7.5),
                    energy: Some(8),
                },
                exercises: vec!["Example walk, 20 minutes".into()],
                fitness: Some(FitnessBody {
                    intent: Some("Example fitness goal".into()),
                    target_date: Some("2026-12-01".into()),
                    days_to_target: Some(36),
                    focus: Some("strength"),
                }),
                nutrition: vec![NutrientBody {
                    key: "protein",
                    label: "Protein",
                    amount: 42.5,
                    unit: "g",
                    sub: false,
                }],
                goals: vec![GoalBody {
                    key: "steps",
                    label: "Steps",
                    actual: 5000.0,
                    goal: 10000.0,
                    percent: 50.0,
                    unit: "",
                }],
            },
        ),
        example(
            "status-empty",
            StatusResponse {
                date: "2026-10-26".into(),
                member: member(),
                activity: ActivityBody {
                    steps: 0,
                    active_calories: 0,
                    sleep_hours: None,
                    energy: None,
                },
                exercises: vec![],
                fitness: None,
                nutrition: vec![],
                goals: vec![],
            },
        ),
        example(
            "status-fitness-nullable",
            StatusResponse {
                date: "2026-10-26".into(),
                member: member(),
                activity: ActivityBody {
                    steps: 0,
                    active_calories: 0,
                    sleep_hours: None,
                    energy: None,
                },
                exercises: vec![],
                fitness: Some(FitnessBody {
                    intent: None,
                    target_date: None,
                    days_to_target: None,
                    focus: None,
                }),
                nutrition: vec![],
                goals: vec![],
            },
        ),
    ]
}
