//! Task endpoints over the same scoped core and calendar operations as Signal.

use super::idempotency::Idempotency;
use super::{ApiError, Caller};
use crate::tasks::{self, ConfigCalendars};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chotu_common::tasks::{DoneTask, Task, TaskError, TaskFilter};
use chotu_common::{AppConfig, MemoryIndex};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/tasks.rs"]
pub(super) mod fixture_examples;

#[derive(Serialize)]
pub(super) struct TaskListResponse {
    /// The household-timezone day (`YYYY-MM-DD`): a task with `due_date` on or
    /// before it is due, the same rule as the morning brief.
    date: String,
    tasks: Vec<Task>,
}

#[derive(Serialize)]
pub(super) struct TaskResponse {
    task: Task,
    #[serde(skip_serializing_if = "Option::is_none")]
    calendar_warning: Option<&'static str>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct SnoozeRequest {
    days: i64,
}

/// `POST /v1/tasks`: a task for the caller, as Signal's `/task` makes it.
#[derive(Deserialize, Serialize)]
pub(super) struct CreateTaskRequest {
    title: String,
    /// Free text Signal accepts after `due`/`by`: `tomorrow 3pm`, `friday`, `2026-11-05`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    due: Option<String>,
    /// Extra context, kept in the task's description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details: Option<String>,
}

#[derive(Serialize)]
pub(super) struct CreatedTaskResponse {
    task: Task,
    /// Context the model pulled out of the text (addresses, preparation).
    details: Option<String>,
    /// Why the title or due time differs from what was sent.
    note: Option<&'static str>,
    /// `scheduled`, `not_linked`, `failed`, or `null` without a due time.
    calendar: Option<&'static str>,
}

#[derive(Deserialize)]
pub(super) struct CompletedQuery {
    /// The previous page's `next_before`.
    before: Option<String>,
    /// 1–50, default 20.
    limit: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct CompletedResponse {
    tasks: Vec<DoneTask>,
    next_before: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct TrendsQuery {
    days: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct TaskTrendsResponse {
    from: String,
    to: String,
    days: i64,
    created: u32,
    completed: u32,
    /// Open tasks now, and how many of them are past due.
    open: u32,
    overdue: u32,
    /// Monday-start weeks touching the range, oldest first.
    weeks: Vec<TaskWeek>,
}

#[derive(Serialize)]
pub(super) struct TaskWeek {
    week_start: String,
    created: u32,
    completed: u32,
}

const MAX_TASK_TITLE_CHARS: usize = 200;
const MAX_TASK_TEXT_CHARS: usize = 2000;
const CURSOR_SEPARATOR: char = '~';

impl From<TaskError> for ApiError {
    fn from(error: TaskError) -> Self {
        match error {
            TaskError::NotFound => Self::Rejected(StatusCode::NOT_FOUND, error.to_string()),
            TaskError::InvalidDays => {
                Self::Rejected(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
            }
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
    State(tz): State<chrono_tz::Tz>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let tasks = tasks::list_tasks(&pool, &scope, TaskFilter::Active, None, None).await?;
    let (_, today) = super::workout::clock(tz);
    Ok(Json(TaskListResponse {
        date: today.to_string(),
        tasks,
    }))
}

pub(super) async fn complete_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(memory): State<MemoryIndex>,
    Path(id): Path<String>,
) -> Response {
    idempotency
        .run(async move {
            tasks::complete_task_by_id(&pool, &id, &scope, &ConfigCalendars(&config), &memory)
                .await
                .map(|completed| {
                    Json(TaskResponse {
                        task: completed.task,
                        calendar_warning: None,
                    })
                })
                .map_err(ApiError::from)
                .into_response()
        })
        .await
}

pub(super) async fn snooze_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(state): State<super::ApiState>,
    Path(id): Path<String>,
    body: Result<Json<SnoozeRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = body?;
    Ok(idempotency
        .run(async move {
            tasks::snooze_task_by_id(
                &state.pool,
                &id,
                body.days,
                state.tz,
                &scope,
                &ConfigCalendars(&state.config),
                &state.memory,
            )
            .await
            .map(|snoozed| {
                Json(TaskResponse {
                    task: snoozed.task,
                    calendar_warning: snoozed
                        .calendar_note
                        .filter(|note| *note == "calendar update failed"),
                })
            })
            .map_err(ApiError::from)
            .into_response()
        })
        .await)
}

fn unprocessable(code: &'static str, message: impl ToString) -> ApiError {
    ApiError::RejectedWithCode(StatusCode::UNPROCESSABLE_ENTITY, code, message.to_string())
}

fn trimmed(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|text| !text.is_empty())
}

/// `POST /v1/tasks`: creates a task assigned to the caller.
pub(super) async fn create_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(state): State<super::ApiState>,
    body: Result<Json<CreateTaskRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = body?;
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(unprocessable("empty_title", "Task title cannot be empty."));
    }
    if title.chars().count() > MAX_TASK_TITLE_CHARS
        || body.due.as_deref().unwrap_or("").chars().count() > MAX_TASK_TITLE_CHARS
        || body.details.as_deref().unwrap_or("").chars().count() > MAX_TASK_TEXT_CHARS
    {
        return Err(unprocessable("too_long", "Task text is too long."));
    }
    let member_id = crate::scope::resolve_task_target(&scope, None, &state.config)
        .map_err(|message| ApiError::Rejected(StatusCode::FORBIDDEN, message.into()))?;
    let due = trimmed(body.due.as_deref()).map(str::to_string);
    let details = trimmed(body.details.as_deref()).map(str::to_string);
    Ok(idempotency
        .run(async move {
            // The same "original text" Signal keeps: what the person wrote.
            let mut source = title.clone();
            if let Some(due) = &due {
                source.push_str(&format!(" by {due}"));
            }
            if let Some(details) = &details {
                source.push_str(&format!("\n{details}"));
            }
            let input = tasks::ManualTaskInput {
                member_id,
                title,
                due_raw: due,
                fallback_due: None,
                source_text: &source,
            };
            let extraction = tasks::extract_task_context(&state.llm, &state.config, &input).await;
            match tasks::create_manual_task(
                &state.pool,
                &state.config,
                input,
                extraction,
                &state.memory,
            )
            .await
            {
                Ok(created) => (
                    StatusCode::CREATED,
                    Json(CreatedTaskResponse {
                        task: created.task,
                        details: created.details,
                        note: created.note,
                        calendar: match created.calendar {
                            tasks::CalendarOutcome::None => None,
                            tasks::CalendarOutcome::Scheduled => Some("scheduled"),
                            tasks::CalendarOutcome::NotLinked => Some("not_linked"),
                            tasks::CalendarOutcome::Failed => Some("failed"),
                        },
                    }),
                )
                    .into_response(),
                Err(error @ tasks::CreateTaskError::EmptyTitle) => {
                    unprocessable("empty_title", error).into_response()
                }
                Err(error @ tasks::CreateTaskError::DueInPast(_)) => {
                    unprocessable("due_in_past", error).into_response()
                }
                Err(error @ tasks::CreateTaskError::DueUnparsed(_)) => {
                    unprocessable("due_unparsed", error).into_response()
                }
                Err(tasks::CreateTaskError::Database(error)) => {
                    eprintln!("api_tasks create failed: {error:?}");
                    ApiError::Internal.into_response()
                }
            }
        })
        .await)
}

/// `POST /v1/tasks/{id}/reopen`: unsnoozes (or reopens) a task in scope.
pub(super) async fn reopen_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(state): State<super::ApiState>,
    Path(id): Path<String>,
) -> Response {
    idempotency
        .run(async move {
            tasks::reopen_task_by_id(&state.pool, &id, &scope, &state.memory)
                .await
                .map(|(task, _)| {
                    Json(TaskResponse {
                        task,
                        calendar_warning: None,
                    })
                })
                .map_err(ApiError::from)
                .into_response()
        })
        .await
}

/// `POST /v1/tasks/{id}/assign`: takes a task for the caller. A linked
/// profile may only take its own or unassigned household tasks.
pub(super) async fn assign_task(
    idempotency: Idempotency,
    Caller(scope): Caller,
    State(state): State<super::ApiState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let member_id = scope
        .member_id()
        .map(str::to_string)
        .ok_or(ApiError::MemberRequired)?;
    Ok(idempotency
        .run(async move {
            tasks::assign_task_by_id(&state.pool, &id, &member_id, &scope, &state.memory)
                .await
                .map(|task| {
                    Json(TaskResponse {
                        task,
                        calendar_warning: None,
                    })
                })
                .map_err(ApiError::from)
                .into_response()
        })
        .await)
}

/// `GET /v1/tasks/completed`: done tasks in scope, most recently completed first.
pub(super) async fn get_completed(
    Caller(scope): Caller,
    State(pool): State<SqlitePool>,
    query: Result<Query<CompletedQuery>, QueryRejection>,
) -> Result<Json<CompletedResponse>, ApiError> {
    let Query(query) = query?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=50).contains(&limit) {
        return Err(unprocessable("bad_limit", "limit must be 1-50"));
    }
    let before = match query.before.as_deref() {
        Some(raw) => Some(
            raw.rsplit_once(CURSOR_SEPARATOR)
                .ok_or_else(|| unprocessable("bad_cursor", "before must be a next_before value"))?,
        ),
        None => None,
    };
    let mut rows =
        chotu_common::tasks::list_done_tasks(&pool, scope.member_id(), before, limit + 1).await?;
    rows.retain(|row| scope.allows_task_assignee(row.task.assigned_to.as_deref()));
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_before = more
        .then(|| rows.last())
        .flatten()
        .map(|row| format!("{}{CURSOR_SEPARATOR}{}", row.completed_at, row.task.id));
    Ok(Json(CompletedResponse {
        tasks: rows,
        next_before,
    }))
}

/// A stored task time: RFC 3339, or SQLite `datetime()` text in UTC.
fn stored_instant(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&chrono::Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|at| at.and_utc())
        })
}

/// `GET /v1/tasks/trends`: tasks created and completed per household week.
pub(super) async fn get_trends(
    Caller(scope): Caller,
    State(pool): State<SqlitePool>,
    State(tz): State<chrono_tz::Tz>,
    query: Result<Query<TrendsQuery>, QueryRejection>,
) -> Result<Json<TaskTrendsResponse>, ApiError> {
    use chrono::{Datelike, Duration};
    let Query(query) = query?;
    let days = query.days.unwrap_or(28);
    if !(7..=90).contains(&days) {
        return Err(unprocessable("bad_days", "days must be 7-90"));
    }
    let (_, to) = super::workout::clock(tz);
    let from = to - Duration::days(days - 1);
    // Household days can start a day earlier or later in UTC.
    let (created, done) = chotu_common::tasks::task_activity(
        &pool,
        scope.member_id(),
        &(from - Duration::days(1)).to_string(),
        &(to + Duration::days(1)).to_string(),
    )
    .await?;
    let monday =
        |day: chrono::NaiveDate| day - Duration::days(day.weekday().num_days_from_monday().into());
    let mut weeks = Vec::new();
    let mut week = monday(from);
    while week <= to {
        weeks.push(TaskWeek {
            week_start: week.to_string(),
            created: 0,
            completed: 0,
        });
        week += Duration::days(7);
    }
    let mut totals = (0, 0);
    for (times, created) in [(&created, true), (&done, false)] {
        for day in times
            .iter()
            .filter_map(|raw| stored_instant(raw))
            .map(|at| at.with_timezone(&tz).date_naive())
            .filter(|day| (from..=to).contains(day))
        {
            let index = ((monday(day) - monday(from)).num_days() / 7) as usize;
            let Some(week) = weeks.get_mut(index) else {
                continue;
            };
            if created {
                week.created += 1;
                totals.0 += 1;
            } else {
                week.completed += 1;
                totals.1 += 1;
            }
        }
    }
    let open = tasks::list_tasks(&pool, &scope, TaskFilter::Open, None, None).await?;
    let today = to.to_string();
    let overdue = open
        .iter()
        .filter(|task| {
            task.due_date
                .as_deref()
                .is_some_and(|due| due < today.as_str())
        })
        .count() as u32;
    Ok(Json(TaskTrendsResponse {
        from: from.to_string(),
        to: today,
        days,
        created: totals.0,
        completed: totals.1,
        open: open.len() as u32,
        overdue,
        weeks,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::idempotency::IDEMPOTENCY_KEY;
    use super::super::tests::{request, test_auth, test_pool, ALEX_PHONE, KITCHEN_IPAD};
    use super::super::{router, ApiServer, ApiState};
    use super::*;
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
                llm: chotu_common::ChotuLlm::new("http://127.0.0.1", 0, "unused"),
                tz: Tz::UTC,
                media: Arc::new(super::super::media::MediaRegistry::new(&config).unwrap()),
                config: Arc::new(config),
                memory: MemoryIndex::with_base_url("http://127.0.0.1:0", "unused"),
                gemini: chotu_common::GeminiClient::new("unused".into()),
            };
            let server = ApiServer::spawn(listener, router(test_auth(), state));
            Self {
                server,
                base,
                client: reqwest::Client::new(),
            }
        }

        async fn call(
            &self,
            method: Method,
            path: &str,
            token: Option<&str>,
            member: Option<&str>,
            key: Option<&str>,
            body: Option<Value>,
        ) -> (u16, Value) {
            let mut builder = request(
                &self.client,
                method,
                format!("{}{path}", self.base),
                token,
                member,
            );
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
            self.call(
                Method::POST,
                path,
                Some(ALEX_PHONE),
                Some("alex"),
                Some(key),
                body,
            )
            .await
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
        assert_eq!(
            app.call(Method::GET, "/v1/tasks", None, None, None, None)
                .await
                .0,
            401
        );
        assert_eq!(
            app.call(Method::GET, "/v1/tasks", Some(ALEX_PHONE), None, None, None)
                .await
                .0,
            400
        );
        let (status, body) = app
            .call(
                Method::GET,
                "/v1/tasks",
                Some(ALEX_PHONE),
                Some("alex"),
                None,
                None,
            )
            .await;
        assert_eq!(status, 200);
        // The test server's household timezone is UTC.
        assert_eq!(body["date"], chrono::Utc::now().date_naive().to_string());
        let rows = body["tasks"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let mine = rows.iter().find(|row| row["id"] == "mine-full-id").unwrap();
        assert_eq!(
            *mine,
            json!({
                "id":"mine-full-id", "title":"Call dentist", "status":"open",
                "due_date":"2020-01-01", "due_at":"2020-01-01T15:00:00Z", "due_has_time":true,
                "assigned_to":"alex", "email_subject":"Appointment",
            })
        );
        let shared = rows
            .iter()
            .find(|row| row["id"] == "unassigned-full-id")
            .unwrap();
        assert_eq!(shared["assigned_to"], Value::Null);
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn complete_denies_other_member_requires_full_id_and_replays_across_devices() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "abcdef12-full-id", Some("alex"), "open").await;
        insert(&pool, "other-full-id", Some("jordan"), "open").await;
        let app = App::start(pool.clone()).await;
        assert_eq!(
            app.call(
                Method::POST,
                "/v1/tasks/abcdef12-full-id/complete",
                Some(ALEX_PHONE),
                Some("alex"),
                None,
                None
            )
            .await
            .0,
            400
        );
        assert_eq!(
            app.write("/v1/tasks/other-full-id/complete", "denied", None)
                .await
                .0,
            404
        );
        assert_eq!(
            app.write("/v1/tasks/abcdef12/complete", "prefix", None)
                .await
                .0,
            404
        );
        let path = "/v1/tasks/abcdef12-full-id/complete";
        let first = app.write(path, "done-once", None).await;
        assert_eq!(first.0, 200);
        assert_eq!(first.1["task"]["status"], "done");
        sqlx::query("UPDATE tasks SET updated_at = 'sentinel' WHERE id = 'abcdef12-full-id'")
            .execute(&pool)
            .await
            .unwrap();
        let replay = app
            .call(
                Method::POST,
                path,
                Some(KITCHEN_IPAD),
                Some("alex"),
                Some("done-once"),
                None,
            )
            .await;
        assert_eq!(replay, first);
        let updated: String =
            sqlx::query_scalar("SELECT updated_at FROM tasks WHERE id = 'abcdef12-full-id'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(updated, "sentinel");
        let other: String =
            sqlx::query_scalar("SELECT status FROM tasks WHERE id = 'other-full-id'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(other, "open");
        let eligible: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE id = 'abcdef12-full-id' AND status = 'open' AND reminded_at IS NULL AND due_at <= ?",
        ).bind(chrono::Utc::now().to_rfc3339()).fetch_one(&pool).await.unwrap();
        assert_eq!(eligible, 0);
        assert_eq!(
            app.write(path, "done-again", None).await.1["task"]["status"],
            "done"
        );
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn snooze_replay_does_not_restart_reminder_cycle_or_apply_changed_body() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "mine", Some("alex"), "open").await;
        let app = App::start(pool.clone()).await;
        let path = "/v1/tasks/mine/snooze";
        let before = chrono::Utc::now().date_naive();
        let first = app
            .write(path, "snooze-once", Some(json!({"days":2})))
            .await;
        assert_eq!(first.0, 200);
        assert_eq!(first.1["task"]["status"], "snoozed");
        assert_eq!(first.1["task"]["due_has_time"], false);
        let date = first.1["task"]["due_date"].as_str().unwrap();
        let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
        let after = chrono::Utc::now().date_naive();
        assert!(
            date == before + chrono::Duration::days(2) || date == after + chrono::Duration::days(2)
        );
        sqlx::query("UPDATE tasks SET reminded_at = 'cycle-sent', due_date = '2099-01-01' WHERE id = 'mine'")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO task_due_reminder_deliveries (task_id, recipient_kind, recipient_id) VALUES ('mine', 'direct', 'aci-alex')")
            .execute(&pool).await.unwrap();
        let replay = app
            .write(path, "snooze-once", Some(json!({"days":5})))
            .await;
        assert_eq!(replay, first);
        let row: (String, Option<String>) =
            sqlx::query_as("SELECT due_date, reminded_at FROM tasks WHERE id = 'mine'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            row,
            ("2099-01-01".to_string(), Some("cycle-sent".to_string()))
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_due_reminder_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            app.write(path, "snooze-again", Some(json!({"days":3})))
                .await
                .0,
            200
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_due_reminder_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let reminded: Option<String> =
            sqlx::query_scalar("SELECT reminded_at FROM tasks WHERE id = 'mine'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(reminded.is_none());
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn snooze_validates_days_denies_scope_and_reports_calendar_failure_without_rollback() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "mine", Some("alex"), "open").await;
        insert(&pool, "other", Some("jordan"), "open").await;
        sqlx::query("UPDATE tasks SET calendar_event_id = 'linked-event' WHERE id = 'mine'")
            .execute(&pool)
            .await
            .unwrap();
        let app = App::start(pool.clone()).await;
        for (index, body) in [
            json!({"days":0}),
            json!({"days":91}),
            json!({"days":1.5}),
            json!({}),
            json!({"days":"2"}),
        ]
        .into_iter()
        .enumerate()
        {
            let response = app
                .write(
                    "/v1/tasks/mine/snooze",
                    &format!("invalid-{index}"),
                    Some(body),
                )
                .await;
            assert_eq!(response.0, 422);
            assert!(response.1["error"].is_string());
        }
        assert_eq!(
            app.write("/v1/tasks/other/snooze", "denied", Some(json!({"days":1})))
                .await
                .0,
            404
        );
        let first = app
            .write(
                "/v1/tasks/mine/snooze",
                "calendar-failed",
                Some(json!({"days":1})),
            )
            .await;
        assert_eq!(first.0, 200);
        assert_eq!(first.1["task"]["status"], "snoozed");
        assert_eq!(first.1["calendar_warning"], "calendar update failed");
        assert_eq!(
            app.write(
                "/v1/tasks/mine/snooze",
                "calendar-failed",
                Some(json!({"days":1}))
            )
            .await,
            first
        );
        let event: Option<String> =
            sqlx::query_scalar("SELECT calendar_event_id FROM tasks WHERE id = 'mine'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(event.as_deref(), Some("linked-event"));
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn create_reopen_assign_completed_and_trends_follow_the_shared_task_rules() {
        let (_dir, pool) = test_pool().await;
        insert(&pool, "shared", None, "open").await;
        insert(&pool, "jordans", Some("jordan"), "snoozed").await;
        let app = App::start(pool.clone()).await;
        let get = |path: &'static str| {
            app.call(
                Method::GET,
                path,
                Some(ALEX_PHONE),
                Some("alex"),
                None,
                None,
            )
        };

        let (status, created) = app
            .write(
                "/v1/tasks",
                "create-1",
                Some(json!({"title": " Buy milk ", "due": "tomorrow 9am", "details": "2%"})),
            )
            .await;
        assert_eq!(status, 201, "{created}");
        let task = &created["task"];
        assert_eq!(task["title"], "Buy milk");
        assert_eq!(task["assigned_to"], "alex");
        assert_eq!(task["status"], "open");
        assert_eq!(task["due_has_time"], true);
        assert!(task["due_date"].is_string());
        // No model in tests: the original text is kept, and it says so.
        assert_eq!(
            created["note"],
            "Context extraction failed; saved the original task."
        );
        assert_eq!(created["calendar"], Value::Null);
        // A retry with the same key is the same task, not a second one.
        let (_, replay) = app
            .write(
                "/v1/tasks",
                "create-1",
                Some(json!({"title": " Buy milk ", "due": "tomorrow 9am", "details": "2%"})),
            )
            .await;
        assert_eq!(replay, created);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE title = 'Buy milk'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let description: String =
            sqlx::query_scalar("SELECT description FROM tasks WHERE title = 'Buy milk'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(description, "Original text:\nBuy milk by tomorrow 9am\n2%");

        for (key, body, code) in [
            ("bad-1", json!({"title": "  "}), "empty_title"),
            (
                "bad-2",
                json!({"title": "x", "due": "2020-01-01"}),
                "due_in_past",
            ),
            (
                "bad-3",
                json!({"title": "x", "due": "whenever-ish"}),
                "due_unparsed",
            ),
        ] {
            let (status, body) = app.write("/v1/tasks", key, Some(body)).await;
            assert_eq!((status, body["code"].as_str()), (422, Some(code)), "{body}");
        }

        let id = task["id"].as_str().unwrap().to_string();
        let path = |action: &str| format!("/v1/tasks/{id}/{action}");
        assert_eq!(app.write(&path("complete"), "done-1", None).await.0, 200);
        assert_eq!(
            app.write("/v1/tasks/shared/complete", "done-2", None)
                .await
                .0,
            200
        );
        let (status, page) = get("/v1/tasks/completed?limit=1").await;
        assert_eq!(status, 200, "{page}");
        assert_eq!(page["tasks"].as_array().unwrap().len(), 1);
        assert!(page["tasks"][0]["completed_at"].is_string());
        let cursor = page["next_before"].as_str().unwrap().to_string();
        let (_, rest) = app
            .call(
                Method::GET,
                &format!("/v1/tasks/completed?before={}", urlencode(&cursor)),
                Some(ALEX_PHONE),
                Some("alex"),
                None,
                None,
            )
            .await;
        assert_eq!(rest["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(rest["next_before"], Value::Null);
        assert_ne!(rest["tasks"][0]["id"], page["tasks"][0]["id"]);

        let (status, trends) = get("/v1/tasks/trends?days=7").await;
        assert_eq!(status, 200, "{trends}");
        assert_eq!(
            (trends["created"].as_u64(), trends["completed"].as_u64()),
            (Some(1), Some(2))
        );
        assert_eq!(trends["days"], 7);

        let (status, reopened) = app.write(&path("reopen"), "reopen-1", None).await;
        assert_eq!(
            (status, reopened["task"]["status"].as_str()),
            (200, Some("open"))
        );
        assert_eq!(
            app.write("/v1/tasks/jordans/reopen", "reopen-2", None)
                .await
                .0,
            404
        );

        assert_eq!(
            app.write("/v1/tasks/shared/reopen", "reopen-3", None)
                .await
                .0,
            200
        );
        let (status, taken) = app.write("/v1/tasks/shared/assign", "assign-1", None).await;
        assert_eq!(
            (status, taken["task"]["assigned_to"].as_str()),
            (200, Some("alex"))
        );
        assert_eq!(
            app.write("/v1/tasks/jordans/assign", "assign-2", None)
                .await
                .0,
            404
        );

        for path in [
            "/v1/tasks/completed?limit=0",
            "/v1/tasks/completed?before=nocursor",
            "/v1/tasks/trends?days=3",
        ] {
            assert_eq!(get(path).await.0, 422, "{path}");
        }
        app.server.shutdown().await;
    }

    fn urlencode(raw: &str) -> String {
        raw.replace('+', "%2B")
            .replace(':', "%3A")
            .replace('~', "%7E")
    }
}
