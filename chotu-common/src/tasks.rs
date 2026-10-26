//! Transport-neutral task listing and transactional mutations.

use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};
use thiserror::Error;

use crate::parse_due_phrase_tz;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: String,
    pub due_date: Option<String>,
    pub due_at: Option<String>,
    pub due_has_time: bool,
    pub assigned_to: Option<String>,
    pub email_subject: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum TaskFilter {
    Open,
    Active,
    Done,
    Ignored,
    Snoozed,
}

#[derive(Debug, Error)]
pub enum TaskError {
    #[error("task not found")]
    NotFound,
    #[error("snooze days must be between 1 and 90")]
    InvalidDays,
    #[error("task database operation failed")]
    Database(#[from] sqlx::Error),
}

/// `member_id` includes unassigned tasks, matching a linked Signal DM.
/// Signal supplies a display limit; the API returns the entire active list.
pub async fn list_tasks(
    pool: &SqlitePool,
    filter: TaskFilter,
    member_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<Task>, TaskError> {
    let mut query = sqlx::QueryBuilder::new(
        "SELECT id, title, status, due_date, due_at, due_has_time, assigned_to, email_subject FROM tasks WHERE ",
    );
    query.push(match filter {
        TaskFilter::Open => "status = 'open'",
        TaskFilter::Active => "status IN ('open', 'snoozed')",
        TaskFilter::Done => "status = 'done'",
        TaskFilter::Ignored => "status = 'ignored'",
        TaskFilter::Snoozed => "status = 'snoozed'",
    });
    if let Some(member_id) = member_id {
        query
            .push(" AND (assigned_to = ")
            .push_bind(member_id)
            .push(" COLLATE NOCASE OR assigned_to IS NULL)");
    }
    query.push(" ORDER BY due_date IS NULL, due_date ASC, created_at DESC");
    if let Some(limit) = limit {
        query.push(" LIMIT ").push_bind(limit);
    }
    Ok(query.build_query_as().fetch_all(pool).await?)
}

async fn load_task(conn: &mut SqliteConnection, id: &str) -> Result<Task, TaskError> {
    sqlx::query_as(
        "SELECT id, title, status, due_date, due_at, due_has_time, assigned_to, email_subject FROM tasks WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(TaskError::NotFound)
}

/// Authorization and the update share a write transaction, so reassignment
/// cannot race a scope check. Denied tasks deliberately look absent.
pub async fn complete_task_by_id(
    pool: &SqlitePool,
    id: &str,
    allows_assignee: impl FnOnce(Option<&str>) -> bool,
    now: DateTime<Utc>,
) -> Result<(Task, bool), TaskError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut task = load_task(&mut tx, id).await?;
    if !allows_assignee(task.assigned_to.as_deref()) {
        return Err(TaskError::NotFound);
    }
    let already = task.status == "done";
    if !already {
        sqlx::query("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
            .bind(now.to_rfc3339())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        task.status.clear();
        task.status.push_str("done");
    }
    tx.commit().await?;
    Ok((task, already))
}

/// A snooze starts a new reminder cycle, from today's household civil date,
/// and intentionally drops any explicit time, just like Signal.
pub async fn snooze_task_by_id(
    pool: &SqlitePool,
    id: &str,
    days: i64,
    allows_assignee: impl FnOnce(Option<&str>) -> bool,
    now: DateTime<Utc>,
    today: NaiveDate,
    tz: Tz,
) -> Result<Task, TaskError> {
    if !(1..=90).contains(&days) {
        return Err(TaskError::InvalidDays);
    }
    let due = (today + chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let due_at = parse_due_phrase_tz(&due, tz).map(|parsed| parsed.due_at);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut task = load_task(&mut tx, id).await?;
    if !allows_assignee(task.assigned_to.as_deref()) {
        return Err(TaskError::NotFound);
    }
    sqlx::query(
        "UPDATE tasks SET status = 'snoozed', due_date = ?, due_at = ?, due_has_time = 0, reminded_at = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(&due)
    .bind(&due_at)
    .bind(now.to_rfc3339())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    clear_due_reminder_deliveries(&mut *tx, id).await?;
    tx.commit().await?;
    task.status.clear();
    task.status.push_str("snoozed");
    task.due_date = Some(due);
    task.due_at = due_at;
    task.due_has_time = false;
    Ok(task)
}

pub async fn clear_due_reminder_deliveries<'e, E>(
    executor: E,
    task_id: &str,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query("DELETE FROM task_due_reminder_deliveries WHERE task_id = ?")
        .bind(task_id)
        .execute(executor)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::init_db(dir.path().join("tasks.sqlite").to_str().unwrap())
            .await
            .unwrap();
        (dir, pool)
    }

    async fn insert(pool: &SqlitePool, id: &str, assignee: Option<&str>, status: &str) {
        sqlx::query(
            "INSERT INTO tasks (id, title, status, assigned_to, created_at, updated_at, due_date, due_at, due_has_time, reminded_at) \
             VALUES (?, ?, ?, ?, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', '2026-10-20', '2026-10-20T15:00:00Z', 1, '2026-10-20T15:00:01Z')",
        )
        .bind(id).bind(id).bind(status).bind(assignee).execute(pool).await.unwrap();
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-25T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[tokio::test]
    async fn completion_is_repeatable_and_denied_tasks_remain_unchanged() {
        let (_dir, pool) = pool().await;
        insert(&pool, "mine", Some("alex"), "open").await;
        insert(&pool, "other", Some("jordan"), "open").await;
        let allows = |assignee: Option<&str>| assignee.is_none_or(|id| id == "alex");
        assert!(matches!(
            complete_task_by_id(&pool, "other", allows, now()).await,
            Err(TaskError::NotFound)
        ));
        let (task, already) = complete_task_by_id(&pool, "mine", allows, now())
            .await
            .unwrap();
        assert!(!already);
        assert_eq!(task.status, "done");
        assert!(
            complete_task_by_id(&pool, "mine", allows, now())
                .await
                .unwrap()
                .1
        );
        let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = 'other'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "open");
        let eligible: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE id = 'mine' AND status = 'open' AND due_at <= ?",
        )
        .bind(now().to_rfc3339())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(eligible, 0);
    }

    #[tokio::test]
    async fn snooze_uses_household_today_and_atomically_starts_a_new_reminder_cycle() {
        let (_dir, pool) = pool().await;
        insert(&pool, "mine", None, "done").await;
        sqlx::query(
            "INSERT INTO task_due_reminder_deliveries (task_id, recipient_kind, recipient_id) \
             VALUES ('mine', 'direct', 'aci-alex')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let tz = chrono_tz::America::Los_Angeles;
        let task = snooze_task_by_id(
            &pool,
            "mine",
            2,
            |_| true,
            now(),
            now().with_timezone(&tz).date_naive(),
            tz,
        )
        .await
        .unwrap();
        assert_eq!(task.status, "snoozed");
        assert_eq!(task.due_date.as_deref(), Some("2026-10-26"));
        assert!(!task.due_has_time);
        assert_eq!(
            task.due_at,
            parse_due_phrase_tz("2026-10-26", tz).map(|due| due.due_at)
        );
        let reminded: Option<String> =
            sqlx::query_scalar("SELECT reminded_at FROM tasks WHERE id = 'mine'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(reminded.is_none());
        let deliveries: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM task_due_reminder_deliveries")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(deliveries, 0);
        for days in [0, 91, i64::MAX] {
            assert!(matches!(
                snooze_task_by_id(&pool, "mine", days, |_| true, now(), now().date_naive(), tz)
                    .await,
                Err(TaskError::InvalidDays)
            ));
        }
    }

    #[tokio::test]
    async fn snooze_rolls_back_task_when_reminder_reset_fails() {
        let (_dir, pool) = pool().await;
        insert(&pool, "mine", None, "open").await;
        sqlx::query("DROP TABLE task_due_reminder_deliveries")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            snooze_task_by_id(
                &pool,
                "mine",
                1,
                |_| true,
                now(),
                now().date_naive(),
                Tz::UTC
            )
            .await,
            Err(TaskError::Database(_))
        ));
        let row: (String, String, bool) =
            sqlx::query_as("SELECT status, due_date, due_has_time FROM tasks WHERE id = 'mine'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row, ("open".to_string(), "2026-10-20".to_string(), true));
    }

    #[tokio::test]
    async fn active_listing_includes_unassigned_and_has_no_api_display_limit() {
        let (_dir, pool) = pool().await;
        for i in 0..30 {
            insert(
                &pool,
                &format!("mine-{i}"),
                Some("ALEX"),
                if i % 2 == 0 { "open" } else { "snoozed" },
            )
            .await;
        }
        insert(&pool, "unassigned", None, "open").await;
        insert(&pool, "other", Some("jordan"), "open").await;
        insert(&pool, "done", Some("alex"), "done").await;
        insert(&pool, "ignored", Some("alex"), "ignored").await;
        assert_eq!(
            list_tasks(&pool, TaskFilter::Active, Some("alex"), None)
                .await
                .unwrap()
                .len(),
            31
        );
        assert_eq!(
            list_tasks(&pool, TaskFilter::Open, Some("alex"), Some(25))
                .await
                .unwrap()
                .len(),
            16
        );
        assert_eq!(
            list_tasks(&pool, TaskFilter::Active, None, Some(25))
                .await
                .unwrap()
                .len(),
            25
        );
    }
}
