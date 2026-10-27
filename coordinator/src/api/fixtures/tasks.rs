use super::*;
use crate::api::fixtures::{example, Examples};

fn task(status: &str, populated: bool) -> Task {
    Task {
        id: "example-task".into(),
        title: "Synthetic reminder".into(),
        status: status.into(),
        due_date: populated.then(|| "2026-10-27".into()),
        due_at: populated.then(|| "2026-10-27T12:00:00Z".into()),
        due_has_time: populated,
        assigned_to: populated.then(|| "example-member".into()),
        email_subject: populated.then(|| "Synthetic subject".into()),
    }
}

pub(in crate::api) fn examples() -> Examples {
    vec![
        example(
            "tasks-list",
            TaskListResponse {
                tasks: vec![task("open", true), task("snoozed", false)],
            },
        ),
        example(
            "task-complete",
            TaskResponse {
                task: task("done", false),
                calendar_warning: None,
            },
        ),
        example(
            "task-snooze",
            TaskResponse {
                task: task("snoozed", true),
                calendar_warning: Some("calendar update failed"),
            },
        ),
        example("task-snooze-request", SnoozeRequest { days: 2 }),
    ]
}
