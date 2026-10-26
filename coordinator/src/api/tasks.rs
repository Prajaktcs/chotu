//! Task endpoints over the same scoped core and calendar operations as Signal.

use super::idempotency::Idempotency;
use super::{ApiError, Caller};
use crate::tasks::{self, ConfigCalendars};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chotu_common::tasks::{Task, TaskError, TaskFilter};
use chotu_common::{AppConfig, MemoryIndex};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Serialize)]
pub(super) struct TaskListResponse {
    tasks: Vec<Task>,
}

#[derive(Serialize)]
pub(super) struct TaskResponse {
    task: Task,
    #[serde(skip_serializing_if = "Option::is_none")]
    calendar_warning: Option<&'static str>,
}

#[derive(Deserialize)]
pub(super) struct SnoozeRequest {
    days: i64,
}

impl From<TaskError> for ApiError {
    fn from(error: TaskError) -> Self {
        match error {
            TaskError::NotFound => Self::Rejected(StatusCode::NOT_FOUND, error.to_string()),
            TaskError::InvalidDays => Self::Rejected(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
            TaskError::Database(_) => {
                eprintln!("api_tasks failed: {error:?}");
                Self::Internal
            }
        }
    }
}

pub(super) async fn get_tasks(
    Caller(scope): Caller,
    State(pool): State<SqlitePool>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let tasks = tasks::list_tasks(&pool, &scope, TaskFilter::Active, None, None).await?;
    Ok(Json(TaskListResponse { tasks }))
}

pub(super) async fn complete_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(memory): State<MemoryIndex>,
    Path(id): Path<String>,
) -> Response {
    idempotency.run(async move {
        tasks::complete_task_by_id(&pool, &id, &scope, &ConfigCalendars(&config), &memory)
            .await
            .map(|completed| Json(TaskResponse { task: completed.task, calendar_warning: None }))
            .map_err(ApiError::from)
            .into_response()
    }).await
}

pub(super) async fn snooze_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(state): State<super::ApiState>,
    Path(id): Path<String>,
    body: Result<Json<SnoozeRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = body?;
    Ok(idempotency.run(async move {
        tasks::snooze_task_by_id(&state.pool, &id, body.days, state.tz, &scope, &ConfigCalendars(&state.config), &state.memory)
            .await
            .map(|snoozed| Json(TaskResponse {
                task: snoozed.task,
                calendar_warning: snoozed.calendar_note.filter(|note| *note == "calendar update failed"),
            }))
            .map_err(ApiError::from)
            .into_response()
    }).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::idempotency::IDEMPOTENCY_KEY;
    use super::super::tests::{request, test_auth, test_pool, ALEX_PHONE, KITCHEN_IPAD};
    use super::super::{router, ApiServer, ApiState};
    use chrono_tz::Tz;
    use reqwest::Method;
    use serde_json::{json, Value};
    use tokio::net::TcpListener;

    struct App {
        server: ApiServer,
        base: String,
        client: reqwest::Client,
    }

    impl App {
        async fn start(pool: SqlitePool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let mut config = AppConfig::default();
            config.family.members.clear();
            let state = ApiState {
                pool,
                tz: Tz::UTC,
                config: Arc::new(config),
                memory: MemoryIndex::with_base_url("http://127.0.0.1:0", "unused"),
            };
            let server = ApiServer::spawn(listener, router(test_auth(), state));
            Self { server, base, client: reqwest::Client::new() }
        }

        async fn call(
            &self, method: Method, path: &str, token: Option<&str>, member: Option<&str>,
            key: Option<&str>, body: Option<Value>,
        ) -> (u16, Value) {
            let mut builder = request(&self.client, method, format!("{}{path}", self.base), token, member);
            if let Some(key) = key {
                builder = builder.header(IDEMPOTENCY_KEY, key);
            }
            if let Some(body) = body {
                builder = builder.json(&body);
            }
            let response = builder.send().await.unwrap();
            (response.status().as_u16(), response.json().await.unwrap())
        }

        async fn write(&self, path: &str, key: &str, body: Option<Value>) -> (u16, Value) {
            self.call(Method::POST, path, Some(ALEX_PHONE), Some("alex"), Some(key), body).await
        }
    }

    async fn insert(pool: &SqlitePool, id: &str, assignee: Option<&str>, status: &str) {
        sqlx::query(
            "INSERT INTO tasks (id, title, assigned_to, status, created_at, updated_at, due_date, due_at, due_has_time, email_subject) \
             VALUES (?, 'Call dentist', ?, ?, '2026-10-25', '2026-10-25', '2020-01-01', '2020-01-01T15:00:00Z', 1, 'Appointment')",
        ).bind(id).bind(assignee).bind(status).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn list_requires_member_and_only_returns_own_and_unassigned_active_tasks() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "mine-full-id", Some("alex"), "open").await;
        insert(&pool, "unassigned-full-id", None, "snoozed").await;
        insert(&pool, "other-full-id", Some("jordan"), "open").await;
        insert(&pool, "done-full-id", Some("alex"), "done").await;
        insert(&pool, "ignored-full-id", Some("alex"), "ignored").await;
        let app = App::start(pool).await;
        assert_eq!(app.call(Method::GET, "/v1/tasks", None, None, None, None).await.0, 401);
        assert_eq!(app.call(Method::GET, "/v1/tasks", Some(ALEX_PHONE), None, None, None).await.0, 400);
        let (status, body) = app.call(Method::GET, "/v1/tasks", Some(ALEX_PHONE), Some("alex"), None, None).await;
        assert_eq!(status, 200);
        let rows = body["tasks"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let mine = rows.iter().find(|row| row["id"] == "mine-full-id").unwrap();
        assert_eq!(*mine, json!({
            "id":"mine-full-id", "title":"Call dentist", "status":"open",
            "due_date":"2020-01-01", "due_at":"2020-01-01T15:00:00Z", "due_has_time":true,
            "assigned_to":"alex", "email_subject":"Appointment",
        }));
        let shared = rows.iter().find(|row| row["id"] == "unassigned-full-id").unwrap();
        assert_eq!(shared["assigned_to"], Value::Null);
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn complete_denies_other_member_requires_full_id_and_replays_across_devices() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "abcdef12-full-id", Some("alex"), "open").await;
        insert(&pool, "other-full-id", Some("jordan"), "open").await;
        let app = App::start(pool.clone()).await;
        assert_eq!(app.call(Method::POST, "/v1/tasks/abcdef12-full-id/complete", Some(ALEX_PHONE), Some("alex"), None, None).await.0, 400);
        assert_eq!(app.write("/v1/tasks/other-full-id/complete", "denied", None).await.0, 404);
        assert_eq!(app.write("/v1/tasks/abcdef12/complete", "prefix", None).await.0, 404);
        let path = "/v1/tasks/abcdef12-full-id/complete";
        let first = app.write(path, "done-once", None).await;
        assert_eq!(first.0, 200);
        assert_eq!(first.1["task"]["status"], "done");
        sqlx::query("UPDATE tasks SET updated_at = 'sentinel' WHERE id = 'abcdef12-full-id'").execute(&pool).await.unwrap();
        let replay = app.call(Method::POST, path, Some(KITCHEN_IPAD), Some("alex"), Some("done-once"), None).await;
        assert_eq!(replay, first);
        let updated: String = sqlx::query_scalar("SELECT updated_at FROM tasks WHERE id = 'abcdef12-full-id'").fetch_one(&pool).await.unwrap();
        assert_eq!(updated, "sentinel");
        let other: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = 'other-full-id'").fetch_one(&pool).await.unwrap();
        assert_eq!(other, "open");
        let eligible: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE id = 'abcdef12-full-id' AND status = 'open' AND reminded_at IS NULL AND due_at <= ?",
        ).bind(chrono::Utc::now().to_rfc3339()).fetch_one(&pool).await.unwrap();
        assert_eq!(eligible, 0);
        assert_eq!(app.write(path, "done-again", None).await.1["task"]["status"], "done");
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn snooze_replay_does_not_restart_reminder_cycle_or_apply_changed_body() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "mine", Some("alex"), "open").await;
        let app = App::start(pool.clone()).await;
        let path = "/v1/tasks/mine/snooze";
        let before = chrono::Utc::now().date_naive();
        let first = app.write(path, "snooze-once", Some(json!({"days":2}))).await;
        assert_eq!(first.0, 200);
        assert_eq!(first.1["task"]["status"], "snoozed");
        assert_eq!(first.1["task"]["due_has_time"], false);
        let date = first.1["task"]["due_date"].as_str().unwrap();
        let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
        let after = chrono::Utc::now().date_naive();
        assert!(date == before + chrono::Duration::days(2) || date == after + chrono::Duration::days(2));
        sqlx::query("UPDATE tasks SET reminded_at = 'cycle-sent', due_date = '2099-01-01' WHERE id = 'mine'")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO task_due_reminder_deliveries (task_id, recipient_kind, recipient_id) VALUES ('mine', 'direct', 'aci-alex')")
            .execute(&pool).await.unwrap();
        let replay = app.write(path, "snooze-once", Some(json!({"days":5}))).await;
        assert_eq!(replay, first);
        let row: (String, Option<String>) = sqlx::query_as("SELECT due_date, reminded_at FROM tasks WHERE id = 'mine'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("2099-01-01".to_string(), Some("cycle-sent".to_string())));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_due_reminder_deliveries").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
        assert_eq!(app.write(path, "snooze-again", Some(json!({"days":3}))).await.0, 200);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_due_reminder_deliveries").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
        let reminded: Option<String> = sqlx::query_scalar("SELECT reminded_at FROM tasks WHERE id = 'mine'").fetch_one(&pool).await.unwrap();
        assert!(reminded.is_none());
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn snooze_validates_days_denies_scope_and_reports_calendar_failure_without_rollback() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "mine", Some("alex"), "open").await;
        insert(&pool, "other", Some("jordan"), "open").await;
        sqlx::query("UPDATE tasks SET calendar_event_id = 'linked-event' WHERE id = 'mine'").execute(&pool).await.unwrap();
        let app = App::start(pool.clone()).await;
        for (index, body) in [
            json!({"days":0}), json!({"days":91}), json!({"days":1.5}), json!({}), json!({"days":"2"}),
        ].into_iter().enumerate() {
            let response = app.write("/v1/tasks/mine/snooze", &format!("invalid-{index}"), Some(body)).await;
            assert_eq!(response.0, 422);
            assert!(response.1["error"].is_string());
        }
        assert_eq!(app.write("/v1/tasks/other/snooze", "denied", Some(json!({"days":1}))).await.0, 404);
        let first = app.write("/v1/tasks/mine/snooze", "calendar-failed", Some(json!({"days":1}))).await;
        assert_eq!(first.0, 200);
        assert_eq!(first.1["task"]["status"], "snoozed");
        assert_eq!(first.1["calendar_warning"], "calendar update failed");
        assert_eq!(app.write("/v1/tasks/mine/snooze", "calendar-failed", Some(json!({"days":1}))).await, first);
        let event: Option<String> = sqlx::query_scalar("SELECT calendar_event_id FROM tasks WHERE id = 'mine'").fetch_one(&pool).await.unwrap();
        assert_eq!(event.as_deref(), Some("linked-event"));
        app.server.shutdown().await;
    }
}
