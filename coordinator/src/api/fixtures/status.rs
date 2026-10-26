use super::*;
use crate::api::fixtures::{example, Examples};
use chotu_common::FitnessFocus;

fn member() -> MemberBody {
    MemberBody {
        id: "example-member".into(),
        name: "Example Member".into(),
    }
}

fn populated(focus: FitnessFocus) -> StatusResponse {
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
        fitness: Some(FitnessBody::from(FitnessOutcome {
            intent: Some("Example fitness goal".into()),
            target_date: Some("2026-12-01".into()),
            days_to_target: Some(36),
            focus: Some(focus),
        })),
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
    }
}

pub(in crate::api) fn examples() -> Examples {
    vec![
        example("status", populated(FitnessFocus::General)),
        example("status-focus-cut", populated(FitnessFocus::Cut)),
        example("status-focus-bulk", populated(FitnessFocus::Bulk)),
        example("status-focus-recomp", populated(FitnessFocus::Recomp)),
        example("status-focus-endurance", populated(FitnessFocus::Endurance)),
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
                fitness: Some(FitnessBody::from(FitnessOutcome {
                    intent: None,
                    target_date: None,
                    days_to_target: None,
                    focus: None,
                })),
                nutrition: vec![],
                goals: vec![],
            },
        ),
    ]
}
