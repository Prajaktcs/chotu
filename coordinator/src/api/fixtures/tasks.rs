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
                date: "2026-10-27".into(),
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
        example(
            "task-create-request",
            CreateTaskRequest {
                title: "Synthetic reminder".into(),
                due: Some("tomorrow 9am".into()),
                details: Some("Synthetic context".into()),
            },
        ),
        example(
            "task-created",
            CreatedTaskResponse {
                task: task("open", true),
                details: Some("Synthetic context".into()),
                note: None,
                calendar: Some("not_linked"),
            },
        ),
        example(
            "task-created-plain",
            CreatedTaskResponse {
                task: task("open", false),
                details: None,
                note: Some("Context extraction failed; saved the original task."),
                calendar: None,
            },
        ),
        example(
            "tasks-completed",
            CompletedResponse {
                tasks: vec![DoneTask {
                    task: task("done", true),
                    completed_at: "2026-10-27T13:00:00+00:00".into(),
                }],
                next_before: Some("2026-10-27T13:00:00+00:00~example-task".into()),
            },
        ),
        example(
            "task-trends",
            TaskTrendsResponse {
                from: "2026-10-21".into(),
                to: "2026-10-27".into(),
                days: 7,
                created: 3,
                completed: 2,
                open: 4,
                overdue: 1,
                weeks: vec![
                    TaskWeek {
                        week_start: "2026-10-19".into(),
                        created: 1,
                        completed: 1,
                    },
                    TaskWeek {
                        week_start: "2026-10-26".into(),
                        created: 2,
                        completed: 1,
                    },
                ],
            },
        ),
    ]
}
