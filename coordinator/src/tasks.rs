//! Shared task orchestration for Signal and the app API.

use crate::scope::CallerScope;
use chotu_common::tasks::{Task, TaskError, TaskFilter};
use chotu_common::{
    build_calendar_client, reschedule_at, AppConfig, CalendarError, GoogleCalendarClient,
    MemoryIndex, TASK_CALENDAR_DURATION_MINUTES,
};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use sqlx::SqlitePool;
use std::future::Future;

/// The two calendar operations used by task mutations. Production resolves
/// credentials through the same member configuration as Signal.
pub(crate) trait TaskCalendars: Sync {
    fn delete(
        &self,
        assigned_to: Option<&str>,
        event_id: &str,
    ) -> impl Future<Output = Result<bool, CalendarError>> + Send;

    fn reschedule(
        &self,
        assigned_to: Option<&str>,
        event_id: &str,
        start: DateTime<Utc>,
        duration_minutes: i64,
    ) -> impl Future<Output = Result<bool, CalendarError>> + Send;
}

pub(crate) struct ConfigCalendars<'a>(pub(crate) &'a AppConfig);

impl TaskCalendars for ConfigCalendars<'_> {
    async fn delete(
        &self,
        assigned_to: Option<&str>,
        event_id: &str,
    ) -> Result<bool, CalendarError> {
        let Some(client) = calendar_client_for_assignee(self.0, assigned_to) else {
            return Ok(false);
        };
        client.delete_event(event_id).await?;
        Ok(true)
    }

    async fn reschedule(
        &self,
        assigned_to: Option<&str>,
        event_id: &str,
        start: DateTime<Utc>,
        duration_minutes: i64,
    ) -> Result<bool, CalendarError> {
        let Some(client) = calendar_client_for_assignee(self.0, assigned_to) else {
            return Ok(false);
        };
        reschedule_at(&client, event_id, start, duration_minutes).await?;
        Ok(true)
    }
}

pub(crate) async fn list_tasks(
    pool: &SqlitePool,
    scope: &CallerScope,
    filter: TaskFilter,
    member_filter: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<Task>, TaskError> {
    let mut tasks =
        chotu_common::tasks::list_tasks(pool, filter, scope.member_id().or(member_filter), limit)
            .await?;
    tasks.retain(|task| scope.allows_task_assignee(task.assigned_to.as_deref()));
    Ok(tasks)
}

pub(crate) struct CompletedTask {
    pub(crate) task: Task,
    pub(crate) already: bool,
}

pub(crate) struct SnoozedTask {
    pub(crate) task: Task,
    pub(crate) calendar_note: Option<&'static str>,
}

pub(crate) async fn complete_task_by_id(
    pool: &SqlitePool,
    task_id: &str,
    scope: &CallerScope,
    calendars: &impl TaskCalendars,
    memory: &MemoryIndex,
) -> Result<CompletedTask, TaskError> {
    let (task, already) = chotu_common::tasks::complete_task_by_id(
        pool,
        task_id,
        |assignee| scope.allows_task_assignee(assignee),
        Utc::now(),
    )
    .await?;
    // The task write is committed. Calendar failures must not become a 5xx
    // that releases the idempotency claim and reapplies a successful write.
    // Retained links can be retried by completing again with a fresh key.
    sync_calendar_after_complete(pool, calendars, task_id).await;
    if !already {
        refresh_task_memory_with_index(pool, task_id, memory).await;
    }
    Ok(CompletedTask { task, already })
}

pub(crate) async fn snooze_task_by_id(
    pool: &SqlitePool,
    task_id: &str,
    days: i64,
    tz: Tz,
    scope: &CallerScope,
    calendars: &impl TaskCalendars,
    memory: &MemoryIndex,
) -> Result<SnoozedTask, TaskError> {
    let now = Utc::now();
    let task = chotu_common::tasks::snooze_task_by_id(
        pool,
        task_id,
        days,
        |assignee| scope.allows_task_assignee(assignee),
        now,
        now.with_timezone(&tz).date_naive(),
        tz,
    )
    .await?;
    let calendar_note = match task.due_at.as_deref() {
        Some(due_at) => sync_calendar_after_snooze(pool, calendars, task_id, due_at).await,
        None => None,
    };
    refresh_task_memory_with_index(pool, task_id, memory).await;
    Ok(SnoozedTask {
        task,
        calendar_note,
    })
}

#[derive(Debug, Clone)]
pub(crate) struct TaskCalendarLink {
    pub(crate) calendar_event_id: Option<String>,
    pub(crate) assigned_to: Option<String>,
    pub(crate) duration_minutes: Option<i64>,
}

async fn load_task_calendar_link(pool: &SqlitePool, task_id: &str) -> Option<TaskCalendarLink> {
    let row: Option<(Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT calendar_event_id, assigned_to, duration_minutes FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .unwrap_or_else(|e| {
        eprintln!(
            "Signal: failed to load calendar link for task {}: {:?}",
            task_id, e
        );
        None
    });

    row.map(
        |(calendar_event_id, assigned_to, duration_minutes)| TaskCalendarLink {
            calendar_event_id,
            assigned_to,
            duration_minutes,
        },
    )
}

fn calendar_client_for_assignee(
    config: &AppConfig,
    assigned_to: Option<&str>,
) -> Option<GoogleCalendarClient> {
    let mid = assigned_to?;
    let member = config.family.members.iter().find(|m| m.id == mid)?;
    build_calendar_client(member)
}

pub(crate) async fn delete_linked_calendar_event(
    calendars: &impl TaskCalendars,
    link: &TaskCalendarLink,
) -> bool {
    let Some(event_id) = link.calendar_event_id.as_deref().filter(|s| !s.is_empty()) else {
        return true;
    };
    match calendars
        .delete(link.assigned_to.as_deref(), event_id)
        .await
    {
        Ok(false) => {
            eprintln!(
                "Signal: skip calendar delete for event {} (no client for assignee {:?})",
                event_id, link.assigned_to
            );
            false
        }
        Ok(true) => {
            println!("Signal: deleted calendar event {}", event_id);
            true
        }
        Err(e) => {
            eprintln!(
                "Signal: failed to delete calendar event {}: {:?}",
                event_id, e
            );
            false
        }
    }
}

pub(crate) async fn clear_task_calendar_event_id(pool: &SqlitePool, task_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    if let Err(e) =
        sqlx::query("UPDATE tasks SET calendar_event_id = NULL, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(task_id)
            .execute(pool)
            .await
    {
        eprintln!(
            "Signal: failed to clear calendar_event_id for {}: {:?}",
            task_id, e
        );
    }
}

/// Delete the linked Google event after a task is marked done; clear the stored
/// id only when delete succeeds (404 counts as success).
async fn sync_calendar_after_complete(
    pool: &SqlitePool,
    calendars: &impl TaskCalendars,
    task_id: &str,
) {
    let Some(link) = load_task_calendar_link(pool, task_id).await else {
        return;
    };
    if link.calendar_event_id.is_none() {
        return;
    }
    if delete_linked_calendar_event(calendars, &link).await {
        clear_task_calendar_event_id(pool, task_id).await;
    }
}

/// Reschedule the linked Google event after a snooze. Returns an optional
/// user-facing note for the confirmation message.
async fn sync_calendar_after_snooze(
    pool: &SqlitePool,
    calendars: &impl TaskCalendars,
    task_id: &str,
    due_at: &str,
) -> Option<&'static str> {
    let link = load_task_calendar_link(pool, task_id).await?;
    if link.calendar_event_id.is_none() {
        return None;
    }
    match reschedule_linked_calendar_event(calendars, pool, task_id, &link, due_at).await {
        CalendarRescheduleOutcome::Updated => Some("📅 calendar updated"),
        CalendarRescheduleOutcome::NoOp => None,
        CalendarRescheduleOutcome::StaleCleared => Some("calendar event was already gone"),
        CalendarRescheduleOutcome::Failed => Some("calendar update failed"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CalendarRescheduleOutcome {
    Updated,
    NoOp,
    StaleCleared,
    Failed,
}

/// Reschedule the linked Google event to `due_at_rfc3339`.
async fn reschedule_linked_calendar_event(
    calendars: &impl TaskCalendars,
    pool: &SqlitePool,
    task_id: &str,
    link: &TaskCalendarLink,
    due_at_rfc3339: &str,
) -> CalendarRescheduleOutcome {
    let Some(event_id) = link.calendar_event_id.as_deref().filter(|s| !s.is_empty()) else {
        return CalendarRescheduleOutcome::NoOp;
    };
    let Ok(due_dt) = chrono::DateTime::parse_from_rfc3339(due_at_rfc3339) else {
        eprintln!(
            "Signal: invalid due_at for calendar reschedule: {}",
            due_at_rfc3339
        );
        return CalendarRescheduleOutcome::Failed;
    };
    let start = due_dt.with_timezone(&chrono::Utc);
    let duration = link
        .duration_minutes
        .unwrap_or(TASK_CALENDAR_DURATION_MINUTES);
    match calendars
        .reschedule(link.assigned_to.as_deref(), event_id, start, duration)
        .await
    {
        Ok(false) => {
            eprintln!(
                "Signal: skip calendar reschedule for event {} (no client for assignee {:?})",
                event_id, link.assigned_to
            );
            CalendarRescheduleOutcome::Failed
        }
        Ok(true) => {
            println!(
                "Signal: rescheduled calendar event {} to {}",
                event_id, due_at_rfc3339
            );
            CalendarRescheduleOutcome::Updated
        }
        Err(chotu_common::CalendarError::Api { status: 404, .. }) => {
            eprintln!(
                "Signal: calendar event {} missing on snooze; clearing stored id",
                event_id
            );
            clear_task_calendar_event_id(pool, task_id).await;
            CalendarRescheduleOutcome::StaleCleared
        }
        Err(e) => {
            eprintln!(
                "Signal: failed to reschedule calendar event {}: {:?}",
                event_id, e
            );
            CalendarRescheduleOutcome::Failed
        }
    }
}
/// Best-effort refresh of one task in the memory index after status/assignment changes.
pub(crate) async fn refresh_task_memory(pool: &SqlitePool, task_id: &str) {
    refresh_task_memory_with_index(pool, task_id, &MemoryIndex::from_env()).await;
}

async fn refresh_task_memory_with_index(pool: &SqlitePool, task_id: &str, index: &MemoryIndex) {
    let row: Option<(
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = match sqlx::query_as(
        "SELECT id, title, description, status, due_date, assigned_to, created_at FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Memory: task lookup failed: {:?}", e);
            return;
        }
    };
    let Some((id, title, description, status, due_date, assigned_to, created_at)) = row else {
        return;
    };
    if let Err(e) = index
        .index_task(
            pool,
            &id,
            &title,
            description.as_deref(),
            &status,
            due_date.as_deref(),
            assigned_to.as_deref(),
            created_at.as_deref(),
        )
        .await
    {
        eprintln!("Memory: failed to reindex task {}: {:?}", id, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU16, Ordering},
        Mutex,
    };

    #[derive(Debug, PartialEq)]
    enum Call {
        Delete(Option<String>, String),
        Reschedule(Option<String>, String, DateTime<Utc>, i64),
    }

    #[derive(Default)]
    struct CalendarStub {
        calls: Mutex<Vec<Call>>,
        status: AtomicU16,
    }

    impl CalendarStub {
        fn result(&self) -> Result<bool, CalendarError> {
            match self.status.load(Ordering::SeqCst) {
                0 => Ok(true),
                status => Err(CalendarError::Api {
                    operation: "test",
                    status,
                    body: "stub failure".to_string(),
                }),
            }
        }
    }

    impl TaskCalendars for CalendarStub {
        async fn delete(
            &self,
            assigned_to: Option<&str>,
            event_id: &str,
        ) -> Result<bool, CalendarError> {
            self.calls.lock().unwrap().push(Call::Delete(
                assigned_to.map(str::to_string),
                event_id.to_string(),
            ));
            self.result()
        }

        async fn reschedule(
            &self,
            assigned_to: Option<&str>,
            event_id: &str,
            start: DateTime<Utc>,
            duration_minutes: i64,
        ) -> Result<bool, CalendarError> {
            self.calls.lock().unwrap().push(Call::Reschedule(
                assigned_to.map(str::to_string),
                event_id.to_string(),
                start,
                duration_minutes,
            ));
            self.result()
        }
    }

    async fn fixture(assignee: &str) -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = chotu_common::init_db(dir.path().join("tasks.sqlite").to_str().unwrap())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO tasks (id, title, assigned_to, created_at, updated_at, due_at, due_has_time, calendar_event_id, duration_minutes) \
             VALUES ('task-full-id', 'Call dentist', ?, '2026-10-25', '2026-10-25', '2020-01-01T00:00:00Z', 1, 'linked-event', 45)",
        ).bind(assignee).execute(&pool).await.unwrap();
        (dir, pool)
    }

    fn scope() -> CallerScope {
        CallerScope::LinkedDm {
            member_id: "alex".to_string(),
        }
    }

    fn memory() -> MemoryIndex {
        MemoryIndex::with_base_url("http://127.0.0.1:0", "unused")
    }

    async fn event_id(pool: &SqlitePool) -> Option<String> {
        sqlx::query_scalar("SELECT calendar_event_id FROM tasks WHERE id = 'task-full-id'")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn completion_deletes_linked_event_and_stops_reminder_eligibility() {
        let (_dir, pool) = fixture("alex").await;
        let calendars = CalendarStub::default();
        let completed = complete_task_by_id(&pool, "task-full-id", &scope(), &calendars, &memory())
            .await
            .unwrap();
        assert!(!completed.already);
        assert_eq!(completed.task.status, "done");
        assert!(event_id(&pool).await.is_none());
        assert_eq!(
            *calendars.calls.lock().unwrap(),
            vec![Call::Delete(
                Some("alex".to_string()),
                "linked-event".to_string()
            ),]
        );
        let eligible: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE status = 'open' AND reminded_at IS NULL AND due_at <= ?",
        ).bind(Utc::now().to_rfc3339()).fetch_one(&pool).await.unwrap();
        assert_eq!(eligible, 0);
        assert!(
            complete_task_by_id(&pool, "task-full-id", &scope(), &calendars, &memory())
                .await
                .unwrap()
                .already
        );
        assert_eq!(calendars.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn member_cannot_complete_or_snooze_another_members_task() {
        let (_dir, pool) = fixture("jordan").await;
        let calendars = CalendarStub::default();
        assert!(matches!(
            complete_task_by_id(&pool, "task-full-id", &scope(), &calendars, &memory()).await,
            Err(TaskError::NotFound)
        ));
        assert!(matches!(
            snooze_task_by_id(
                &pool,
                "task-full-id",
                1,
                Tz::UTC,
                &scope(),
                &calendars,
                &memory()
            )
            .await,
            Err(TaskError::NotFound)
        ));
        assert!(calendars.calls.lock().unwrap().is_empty());
        assert_eq!(event_id(&pool).await.as_deref(), Some("linked-event"));
    }

    #[tokio::test]
    async fn snooze_reschedules_same_event_with_original_duration() {
        let (_dir, pool) = fixture("alex").await;
        let calendars = CalendarStub::default();
        let snoozed = snooze_task_by_id(
            &pool,
            "task-full-id",
            3,
            Tz::UTC,
            &scope(),
            &calendars,
            &memory(),
        )
        .await
        .unwrap();
        assert_eq!(snoozed.task.status, "snoozed");
        assert!(!snoozed.task.due_has_time);
        assert_eq!(snoozed.calendar_note, Some("📅 calendar updated"));
        let start = DateTime::parse_from_rfc3339(snoozed.task.due_at.as_deref().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            *calendars.calls.lock().unwrap(),
            vec![Call::Reschedule(
                Some("alex".to_string()),
                "linked-event".to_string(),
                start,
                45
            ),]
        );
        assert_eq!(event_id(&pool).await.as_deref(), Some("linked-event"));
    }

    #[tokio::test]
    async fn failed_completion_keeps_link_and_recompletion_retries_delete() {
        let (_dir, pool) = fixture("alex").await;
        let calendars = CalendarStub::default();
        calendars.status.store(503, Ordering::SeqCst);
        let first = complete_task_by_id(&pool, "task-full-id", &scope(), &calendars, &memory())
            .await
            .unwrap();
        assert_eq!(first.task.status, "done");
        assert_eq!(event_id(&pool).await.as_deref(), Some("linked-event"));
        calendars.status.store(0, Ordering::SeqCst);
        assert!(
            complete_task_by_id(&pool, "task-full-id", &scope(), &calendars, &memory())
                .await
                .unwrap()
                .already
        );
        assert!(event_id(&pool).await.is_none());
        assert_eq!(calendars.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn snooze_failure_is_reported_and_404_clears_stale_link() {
        let (_dir, pool) = fixture("alex").await;
        let calendars = CalendarStub::default();
        calendars.status.store(503, Ordering::SeqCst);
        let snoozed = snooze_task_by_id(
            &pool,
            "task-full-id",
            1,
            Tz::UTC,
            &scope(),
            &calendars,
            &memory(),
        )
        .await
        .unwrap();
        assert_eq!(snoozed.task.status, "snoozed");
        assert_eq!(snoozed.calendar_note, Some("calendar update failed"));
        assert_eq!(event_id(&pool).await.as_deref(), Some("linked-event"));
        calendars.status.store(404, Ordering::SeqCst);
        let snoozed = snooze_task_by_id(
            &pool,
            "task-full-id",
            1,
            Tz::UTC,
            &scope(),
            &calendars,
            &memory(),
        )
        .await
        .unwrap();
        assert_eq!(
            snoozed.calendar_note,
            Some("calendar event was already gone")
        );
        assert!(event_id(&pool).await.is_none());
    }
}
