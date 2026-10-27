//! This week's training plan and explicit in-app generation/replacement, using
//! the same guarded generator and `health_coach::plan_week` core as Signal.

use super::idempotency::Idempotency;
use super::media::{self, ExerciseMedia};
use super::workout::{
    clock, member_id, member_weight_unit, planned_exercises, PlanDayBody, PlannedExerciseBody,
};
use super::{ApiError, ApiState, Caller};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chotu_common::AppConfig;
use chrono::{Duration, NaiveDate};
use chrono_tz::Tz;
use health_coach::{PlanDay, PlanProgress, PlanToday, PlanWeek, WeightUnit};
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/plan.rs"]
pub(super) mod fixture_examples;

#[derive(Debug, Serialize)]
pub(super) struct PlanResponse {
    /// Household-timezone day, `YYYY-MM-DD`.
    date: String,
    /// Monday of this week, `YYYY-MM-DD`.
    week_start: String,
    /// `null` without fitness goals, before this week's plan is generated, or
    /// when the stored plan can't be read.
    plan: Option<PlanBody>,
    /// Why `plan` is `null`: `no_fitness_goals`, `not_generated` or `unreadable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct PlanBody {
    theme: String,
    /// Monday to Sunday.
    days: Vec<DayBody>,
    /// Today's session with a target per exercise; `null` outside the week.
    today: Option<TodayBody>,
    /// `null` when the week's logs could not be read.
    progress: Option<ProgressBody>,
}

#[derive(Debug, Serialize)]
struct DayBody {
    date: String,
    weekday: String,
    kind: &'static str,
    notes: String,
    is_today: bool,
    exercises: Vec<ExerciseBody>,
}

#[derive(Debug, Serialize)]
struct ExerciseBody {
    name: String,
    sets: u32,
    reps: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    media: Option<ExerciseMedia>,
}

#[derive(Debug, Serialize)]
struct TodayBody {
    #[serde(flatten)]
    day: PlanDayBody,
    exercises: Vec<PlannedExerciseBody>,
}

#[derive(Debug, Serialize)]
struct ProgressBody {
    sessions_matched: i32,
    sessions_planned: i32,
    cardio_minutes: i32,
    planned_cardio_minutes: i32,
}

impl From<PlanProgress> for ProgressBody {
    fn from(progress: PlanProgress) -> Self {
        Self {
            sessions_matched: progress.sessions_matched,
            sessions_planned: progress.sessions_planned,
            cardio_minutes: progress.cardio_minutes,
            planned_cardio_minutes: progress.planned_cardio_minutes,
        }
    }
}

impl TodayBody {
    fn new(today: PlanToday, unit: WeightUnit, config: &AppConfig) -> Self {
        let exercises = planned_exercises(today.day.exercises.clone(), today.targets, unit, config);
        Self {
            day: today.day.into(),
            exercises,
        }
    }
}

fn day_body(day: PlanDay, date: NaiveDate, today: NaiveDate, config: &AppConfig) -> DayBody {
    DayBody {
        date: date.format("%Y-%m-%d").to_string(),
        weekday: day.weekday,
        kind: day.kind.as_str(),
        notes: day.notes,
        is_today: date == today,
        exercises: day
            .exercises
            .into_iter()
            .map(|exercise| ExerciseBody {
                media: media::for_exercise(config, &exercise.name),
                name: exercise.name,
                sets: exercise.sets,
                reps: exercise.reps,
            })
            .collect(),
    }
}

impl PlanBody {
    /// `None` when the stored plan no longer parses.
    fn new(
        week: PlanWeek,
        monday: NaiveDate,
        today: NaiveDate,
        unit: WeightUnit,
        config: &AppConfig,
    ) -> Option<Self> {
        let plan = week.plan?;
        Some(Self {
            theme: plan.theme,
            days: plan
                .days
                .into_iter()
                .zip(0..)
                .map(|(day, offset)| day_body(day, monday + Duration::days(offset), today, config))
                .collect(),
            today: week.today.map(|today| TodayBody::new(today, unit, config)),
            progress: week.progress.map(ProgressBody::from),
        })
    }
}

/// Builds both read and write responses without reloading a successfully saved plan.
fn plan_response(
    week: Option<PlanWeek>,
    today: NaiveDate,
    monday: NaiveDate,
    unit: WeightUnit,
    config: &AppConfig,
    missing_reason: &'static str,
) -> PlanResponse {
    let (plan, reason) = match week {
        Some(week) => match PlanBody::new(week, monday, today, unit, config) {
            Some(plan) => (Some(plan), None),
            None => (None, Some("unreadable")),
        },
        None => (None, Some(missing_reason)),
    };
    PlanResponse {
        date: today.format("%Y-%m-%d").to_string(),
        week_start: monday.format("%Y-%m-%d").to_string(),
        plan,
        reason,
    }
}

pub(super) async fn generate_plan(
    idempotency: Idempotency,
    caller: Caller,
    State(state): State<ApiState>,
) -> Response {
    generate(idempotency, caller, state, false).await
}

pub(super) async fn regenerate_plan(
    idempotency: Idempotency,
    caller: Caller,
    State(state): State<ApiState>,
) -> Response {
    generate(idempotency, caller, state, true).await
}

async fn generate(
    idempotency: Idempotency,
    caller: Caller,
    state: ApiState,
    regenerate: bool,
) -> Response {
    idempotency
        .run(async move {
            let member_id = match member_id(caller) {
                Ok(member_id) => member_id,
                Err(error) => return error.into_response(),
            };
            if !crate::status::has_fitness_goals(&state.config, &member_id) {
                return ApiError::RejectedWithCode(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "no_fitness_goals",
                    "Add fitness goals in config.yaml before generating a plan.".into(),
                )
                .into_response();
            }
            let (_, today) = clock(state.tz);
            let monday = health_coach::week_start_monday(today);
            let stored = match health_coach::generate_and_store_weekly_plan(
                &state.pool,
                &state.llm,
                &state.config,
                &member_id,
                &monday.format("%Y-%m-%d").to_string(),
                regenerate,
            )
            .await
            {
                Ok(stored) => stored,
                Err(error) => {
                    eprintln!("api_plan generation failed: {error:?}");
                    return ApiError::Rejected(
                        StatusCode::BAD_GATEWAY,
                        "Could not generate a plan. Try again.".into(),
                    )
                    .into_response();
                }
            };
            let unit = member_weight_unit(&state.config, &member_id);
            let week = health_coach::plan_week(&state.pool, &member_id, &stored, today, unit).await;
            Json(plan_response(
                Some(week),
                today,
                monday,
                unit,
                &state.config,
                "not_generated",
            ))
            .into_response()
        })
        .await
}

/// `GET /v1/plan` remains read-only, including pull-to-refresh.
pub(super) async fn get_plan(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
) -> Result<Json<PlanResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let unit = member_weight_unit(&config, &member_id);
    let (_, today) = clock(tz);
    let monday = health_coach::week_start_monday(today);
    if !crate::status::has_fitness_goals(&config, &member_id) {
        return Ok(Json(plan_response(
            None,
            today,
            monday,
            unit,
            &config,
            "no_fitness_goals",
        )));
    }
    let week = health_coach::current_plan_week(
        &pool,
        &member_id,
        today,
        health_coach::PlanRead::WithTargets,
        unit,
    )
    .await
    .map_err(|error| {
        eprintln!("api_plan failed: {error:?}");
        ApiError::Internal
    })?;
    Ok(Json(plan_response(
        week,
        today,
        monday,
        unit,
        &config,
        "not_generated",
    )))
}

#[cfg(test)]
mod tests {
    use super::super::idempotency::IDEMPOTENCY_KEY;
    use super::super::tests::{
        get_json, request, serve_router, serve_router_with_llm, test_pool, ALEX_PHONE, KITCHEN_IPAD,
    };
    use crate::status::fixtures;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::{Json, Router};
    use chotu_common::ChotuLlm;
    use health_coach::WeeklyFitnessPlan;
    use health_coach::WeightUnit;
    use serde_json::{json, Value};
    use sqlx::SqlitePool;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::sync::{Notify, Semaphore};

    struct ModelState {
        plan: Mutex<WeeklyFitnessPlan>,
        fail: AtomicBool,
        calls: AtomicUsize,
        extraction_calls: AtomicUsize,
        text_calls: AtomicUsize,
        started: Notify,
        release: Semaphore,
        block_first: bool,
    }

    struct FakeOllama {
        llm: ChotuLlm,
        state: Arc<ModelState>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FakeOllama {
        async fn start(theme: &str, block_first: bool) -> Self {
            let mut plan = fixtures::plan();
            plan.theme = theme.into();
            plan.days[0].exercises[0].name = "Barbell back squat".into();
            let state = Arc::new(ModelState {
                plan: Mutex::new(plan),
                fail: AtomicBool::new(false),
                calls: AtomicUsize::new(0),
                extraction_calls: AtomicUsize::new(0),
                text_calls: AtomicUsize::new(0),
                started: Notify::new(),
                release: Semaphore::new(0),
                block_first,
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let app = Router::new()
                .route("/api/chat", axum::routing::post(model_reply))
                .with_state(state.clone());
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Self {
                llm: ChotuLlm::new("http://127.0.0.1", port, "test"),
                state,
                task,
            }
        }

        fn calls(&self) -> usize {
            self.state.calls.load(Ordering::SeqCst)
        }
    }

    impl Drop for FakeOllama {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn model_reply(
        State(state): State<Arc<ModelState>>,
        Json(body): Json<Value>,
    ) -> Response {
        let call = state.calls.fetch_add(1, Ordering::SeqCst);
        if body["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty())
        {
            state.extraction_calls.fetch_add(1, Ordering::SeqCst);
        } else {
            state.text_calls.fetch_add(1, Ordering::SeqCst);
        }
        state.started.notify_one();
        if state.block_first && call == 0 {
            state.release.acquire().await.unwrap().forget();
        }
        if state.fail.load(Ordering::SeqCst) {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "synthetic model failure"})),
            )
                .into_response();
        }
        let plan = state.plan.lock().unwrap().clone();
        Json(json!({
            "model": "test", "created_at": "2026-10-04T12:00:00Z",
            "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"function": {"name": "submit", "arguments": plan}}]
            },
            "done": true, "done_reason": "stop"
        }))
        .into_response()
    }

    async fn post_plan(
        base: &str,
        path: &str,
        token: Option<&str>,
        member: Option<&str>,
        key: Option<&str>,
    ) -> (u16, Value) {
        let client = reqwest::Client::new();
        let mut builder = request(
            &client,
            reqwest::Method::POST,
            format!("{base}{path}"),
            token,
            member,
        );
        if let Some(key) = key {
            builder = builder.header(IDEMPOTENCY_KEY, key);
        }
        let response = builder.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
    }

    async fn alex_post(base: &str, regenerate: bool, key: &str) -> (u16, Value) {
        post_plan(
            base,
            if regenerate {
                "/v1/plan/regenerate"
            } else {
                "/v1/plan"
            },
            Some(ALEX_PHONE),
            Some("alex"),
            Some(key),
        )
        .await
    }

    fn current_week() -> String {
        health_coach::week_start_monday(chrono::Utc::now().date_naive())
            .format("%Y-%m-%d")
            .to_string()
    }

    async fn stored_bytes(pool: &SqlitePool) -> (String, String, String) {
        sqlx::query_as(
            "SELECT plan_json, plan_md, created_at FROM fitness_weekly_plans WHERE family_member_id = 'alex' AND week_start = ?",
        ).bind(current_week()).fetch_one(pool).await.unwrap()
    }

    type SessionRow = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
    );
    type SetRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        Option<f64>,
        i64,
        String,
    );

    async fn workout_rows(
        pool: &SqlitePool,
    ) -> (Vec<SessionRow>, Vec<SetRow>, Vec<(String, String)>) {
        let sessions = sqlx::query_as(
            "SELECT id, family_member_id, date, current_exercise, started_at, last_activity_at, closed_at FROM fitness_workout_sessions ORDER BY id",
        ).fetch_all(pool).await.unwrap();
        let sets = sqlx::query_as(
            "SELECT id, session_id, family_member_id, date, exercise_key, exercise_name, weight_lb, reps, created_at FROM fitness_set_log ORDER BY id",
        ).fetch_all(pool).await.unwrap();
        let exercises = sqlx::query_as("SELECT id, description FROM exercise_log ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap();
        (sessions, sets, exercises)
    }

    #[tokio::test]
    async fn generates_current_week_for_selected_member_and_get_matches() {
        let (_dir, pool) = test_pool().await;
        let fake = FakeOllama::start("Generated training week", false).await;
        let mut config = fixtures::config();
        config.exercise_media = super::super::media::tests::config().exercise_media;
        let (server, base) = serve_router_with_llm(pool.clone(), config, fake.llm.clone()).await;
        let (status, body) = alex_post(&base, false, "generate").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["week_start"], current_week());
        assert_eq!(
            body["date"],
            chrono::Utc::now()
                .date_naive()
                .format("%Y-%m-%d")
                .to_string()
        );
        assert_eq!(body["plan"]["theme"], "Generated training week");
        assert_eq!(body["plan"]["days"].as_array().unwrap().len(), 7);
        assert!(body["plan"]["days"][0]["exercises"][1]
            .get("media")
            .is_some());
        let (status, read) = get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        assert_eq!(read, body);
        let stored = health_coach::load_weekly_plan(&pool, "alex", &current_week())
            .await
            .unwrap()
            .unwrap();
        let plan: WeeklyFitnessPlan = serde_json::from_str(&stored.plan_json).unwrap();
        assert_eq!(plan.days.len(), 7);
        assert_eq!(plan.theme, "Generated training week");
        assert!(
            health_coach::load_weekly_plan(&pool, "jordan", &current_week())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(fake.calls(), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn generate_preserves_existing_and_regenerate_preserves_workout_history() {
        let (_dir, pool) = test_pool().await;
        let monday = health_coach::week_start_monday(chrono::Utc::now().date_naive());
        fixtures::seed_plan(&pool, monday).await;
        let before = stored_bytes(&pool).await;
        let logs = workout_rows(&pool).await;
        assert!(!logs.0.is_empty() && !logs.1.is_empty() && !logs.2.is_empty());
        let fake = FakeOllama::start("Replacement week", false).await;
        let (server, base) =
            serve_router_with_llm(pool.clone(), fixtures::config(), fake.llm.clone()).await;
        for key in ["existing-1", "existing-2"] {
            let (status, body) = alex_post(&base, false, key).await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(body["plan"]["theme"], "Build the base");
        }
        assert_eq!(stored_bytes(&pool).await, before);
        assert_eq!(fake.calls(), 0);
        let (status, replacement) = alex_post(&base, true, "replacement").await;
        assert_eq!(status, 200, "{replacement}");
        assert_eq!(replacement["plan"]["theme"], "Replacement week");
        assert_eq!(
            replacement["plan"]["days"][0]["exercises"][0]["name"],
            "Barbell back squat"
        );
        assert_ne!(stored_bytes(&pool).await.0, before.0);
        assert_eq!(workout_rows(&pool).await, logs);
        assert_eq!(fake.calls(), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn plan_generation_requires_auth_member_key_and_goals() {
        let (_dir, pool) = test_pool().await;
        let fake = FakeOllama::start("Unused", false).await;
        let (server, base) =
            serve_router_with_llm(pool.clone(), fixtures::config(), fake.llm.clone()).await;
        for path in ["/v1/plan", "/v1/plan/regenerate"] {
            assert_eq!(
                post_plan(&base, path, None, Some("alex"), Some("auth"))
                    .await
                    .0,
                401
            );
            assert_eq!(
                post_plan(&base, path, Some(ALEX_PHONE), None, Some("member"))
                    .await
                    .0,
                400
            );
            assert_eq!(
                post_plan(&base, path, Some(ALEX_PHONE), Some("alex"), None)
                    .await
                    .0,
                400
            );
            assert_eq!(
                post_plan(&base, path, Some(ALEX_PHONE), Some("jordan"), Some("scope"))
                    .await
                    .0,
                403
            );
            let (status, body) =
                post_plan(&base, path, Some(KITCHEN_IPAD), Some("jordan"), Some(path)).await;
            assert_eq!(status, 422, "{body}");
            assert_eq!(
                body,
                json!({
                    "code": "no_fitness_goals",
                    "error": "Add fitness goals in config.yaml before generating a plan."
                })
            );
        }
        assert_eq!(fake.calls(), 0);
        assert!(
            health_coach::load_weekly_plan(&pool, "jordan", &current_week())
                .await
                .unwrap()
                .is_none()
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn unreadable_saved_plan_requires_explicit_regeneration() {
        let (_dir, pool) = test_pool().await;
        fixtures::seed_plan(
            &pool,
            health_coach::week_start_monday(chrono::Utc::now().date_naive()),
        )
        .await;
        sqlx::query("UPDATE fitness_weekly_plans SET plan_json = '{not json' WHERE family_member_id = 'alex'")
            .execute(&pool).await.unwrap();
        let before = stored_bytes(&pool).await;
        let fake = FakeOllama::start("Readable replacement", false).await;
        let (server, base) =
            serve_router_with_llm(pool.clone(), fixtures::config(), fake.llm.clone()).await;
        let (status, body) = alex_post(&base, false, "read-unreadable").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["plan"], Value::Null);
        assert_eq!(body["reason"], "unreadable");
        assert_eq!(stored_bytes(&pool).await, before);
        assert_eq!(fake.calls(), 0);
        let (status, body) = alex_post(&base, true, "replace-unreadable").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["plan"]["theme"], "Readable replacement");
        assert_eq!(fake.calls(), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn generation_replay_is_original_and_reused_path_is_rejected() {
        let (_dir, pool) = test_pool().await;
        let fake = FakeOllama::start("Original generated week", false).await;
        let (server, base) =
            serve_router_with_llm(pool.clone(), fixtures::config(), fake.llm.clone()).await;
        let original = alex_post(&base, false, "original").await;
        assert_eq!(original.0, 200, "{:?}", original.1);
        assert_eq!(alex_post(&base, false, "original").await, original);
        assert_eq!(fake.calls(), 1);
        assert_eq!(alex_post(&base, true, "original").await.0, 422);
        fake.state.plan.lock().unwrap().theme = "Later replacement".into();
        let replacement = alex_post(&base, true, "later").await;
        assert_eq!(replacement.0, 200, "{:?}", replacement.1);
        assert_eq!(replacement.1["plan"]["theme"], "Later replacement");
        assert_eq!(alex_post(&base, true, "later").await, replacement);
        assert_eq!(alex_post(&base, false, "original").await, original);
        assert_eq!(fake.calls(), 2);
        let other_member = post_plan(
            &base,
            "/v1/plan",
            Some(KITCHEN_IPAD),
            Some("jordan"),
            Some("original"),
        )
        .await;
        assert_eq!(other_member.0, 422);
        assert_eq!(other_member.1["code"], "no_fitness_goals");
        assert!(stored_bytes(&pool).await.0.contains("Later replacement"));
        server.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_api_and_signal_style_generates_share_one_model_result() {
        let (_dir, pool) = test_pool().await;
        let fake = FakeOllama::start("One shared generation", true).await;
        let config = fixtures::config();
        let (server, base) =
            serve_router_with_llm(pool.clone(), config.clone(), fake.llm.clone()).await;
        let signal = tokio::spawn({
            let pool = pool.clone();
            let llm = fake.llm.clone();
            async move {
                health_coach::generate_and_store_weekly_plan(
                    &pool,
                    &llm,
                    &config,
                    "alex",
                    &current_week(),
                    false,
                )
                .await
                .unwrap()
            }
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fake.state.started.notified(),
        )
        .await
        .unwrap();
        let first = tokio::spawn({
            let base = base.clone();
            async move { alex_post(&base, false, "concurrent-first").await }
        });
        let second = tokio::spawn({
            let base = base.clone();
            async move { alex_post(&base, false, "concurrent-second").await }
        });
        // Observe both authenticated writes claimed while the shared generator
        // is still blocked inside the model request, rather than relying on sleeps.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let claimed: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM api_write_requests WHERE request_id IN ('concurrent-first', 'concurrent-second') AND status IS NULL",
                ).fetch_one(&pool).await.unwrap();
                if claimed == 2 { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert_eq!(alex_post(&base, false, "concurrent-first").await.0, 409);
        fake.state.release.add_permits(1);
        let signal = signal.await.unwrap();
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(first.0, 200, "{:?}", first.1);
        assert_eq!(second, first);
        assert_eq!(first.1["plan"]["theme"], "One shared generation");
        assert_eq!(signal.plan_json, stored_bytes(&pool).await.0);
        assert_eq!(fake.calls(), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn failed_generation_preserves_saved_bytes_and_same_key_retry_can_replace() {
        let (_dir, pool) = test_pool().await;
        fixtures::seed_plan(
            &pool,
            health_coach::week_start_monday(chrono::Utc::now().date_naive()),
        )
        .await;
        let before = stored_bytes(&pool).await;
        let logs = workout_rows(&pool).await;
        let fake = FakeOllama::start("Recovered replacement", false).await;
        fake.state.fail.store(true, Ordering::SeqCst);
        let (server, base) =
            serve_router_with_llm(pool.clone(), fixtures::config(), fake.llm.clone()).await;
        let old = get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await;
        let (status, error) = alex_post(&base, true, "retry-replacement").await;
        assert_eq!(status, 502, "{error}");
        assert_eq!(
            error,
            json!({"error": "Could not generate a plan. Try again."})
        );
        assert!(fake.state.extraction_calls.load(Ordering::SeqCst) > 0);
        assert!(fake.state.text_calls.load(Ordering::SeqCst) > 0);
        assert_eq!(stored_bytes(&pool).await, before);
        assert_eq!(workout_rows(&pool).await, logs);
        assert_eq!(
            get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await,
            old
        );
        fake.state.fail.store(false, Ordering::SeqCst);
        let recovered = alex_post(&base, true, "retry-replacement").await;
        assert_eq!(recovered.0, 200, "{:?}", recovered.1);
        assert_eq!(recovered.1["plan"]["theme"], "Recovered replacement");
        let calls = fake.calls();
        assert_eq!(alex_post(&base, true, "retry-replacement").await, recovered);
        assert_eq!(fake.calls(), calls);
        assert_eq!(workout_rows(&pool).await, logs);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn curated_media_is_present_in_week_and_today_only_for_configured_exercises() {
        let (_dir, pool) = test_pool().await;
        let today = chrono::Utc::now().date_naive();
        let monday = health_coach::week_start_monday(today);
        let mut plan = fixtures::plan();
        for day in &mut plan.days {
            day.kind = health_coach::PlanDayKind::Strength;
            day.exercises = vec![
                health_coach::PlanExercise {
                    name: "Bench-press".into(),
                    sets: 3,
                    reps: "8".into(),
                },
                health_coach::PlanExercise {
                    name: "Unmapped lift".into(),
                    sets: 2,
                    reps: "10".into(),
                },
            ];
        }
        health_coach::save_weekly_plan(
            &pool,
            "alex",
            &monday.format("%Y-%m-%d").to_string(),
            &plan,
        )
        .await
        .unwrap();
        let mut config = fixtures::config();
        config.exercise_media = super::super::media::tests::config().exercise_media;
        let (server, base) = serve_router(pool, config).await;
        let (status, body) = get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        let expected = json!({
            "type": "hosted",
            "video_url": format!("/v1/exercise-media/{}/video", "a".repeat(64)),
            "poster_url": format!("/v1/exercise-media/{}/poster", "b".repeat(64)),
        });
        for day in body["plan"]["days"].as_array().unwrap() {
            assert_eq!(day["exercises"][0]["media"], expected);
            assert!(day["exercises"][1].get("media").is_none());
        }
        assert_eq!(body["plan"]["today"]["exercises"][0]["media"], expected);
        assert!(body["plan"]["today"]["exercises"][1].get("media").is_none());
        server.shutdown().await;
    }

    #[tokio::test]
    async fn plan_explains_why_there_is_none() {
        let (_dir, pool) = test_pool().await;
        let (server, base) = serve_router(pool, fixtures::config()).await;
        assert_eq!(get_json(&base, "/v1/plan", None, None).await.0, 401);
        assert_eq!(
            get_json(&base, "/v1/plan", Some(ALEX_PHONE), None).await.0,
            400
        );
        let today = chrono::Utc::now().date_naive();
        let monday = health_coach::week_start_monday(today);
        let (status, body) = get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        assert_eq!(
            body,
            json!({
                "date": today.format("%Y-%m-%d").to_string(),
                "week_start": monday.format("%Y-%m-%d").to_string(),
                "plan": null,
                "reason": "not_generated",
            })
        );
        let (status, body) = get_json(&base, "/v1/plan", Some(KITCHEN_IPAD), Some("jordan")).await;
        assert_eq!(status, 200);
        assert_eq!(body["plan"], Value::Null);
        assert_eq!(body["reason"], "no_fitness_goals");
        server.shutdown().await;
    }

    /// A stored plan whose JSON no longer parses is reported, not a 500.
    #[tokio::test]
    async fn unreadable_stored_plan_is_null_with_a_reason() {
        let (_dir, pool) = test_pool().await;
        let today = chrono::Utc::now().date_naive();
        let monday = health_coach::week_start_monday(today);
        fixtures::seed_plan(&pool, monday).await;
        sqlx::query("UPDATE fitness_weekly_plans SET plan_json = '{not json' WHERE family_member_id = 'alex'")
            .execute(&pool)
            .await
            .unwrap();
        let (server, base) = serve_router(pool, fixtures::config()).await;
        let (status, body) = get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["plan"], Value::Null);
        assert_eq!(body["reason"], "unreadable");
        server.shutdown().await;
    }

    /// The week, today's targets and progress are the ones Signal's `/plan`
    /// prints that day.
    #[tokio::test]
    async fn plan_values_match_the_signal_reply_for_the_same_day() {
        let (_dir, pool) = test_pool().await;
        let today = chrono::Utc::now().date_naive();
        let monday = health_coach::week_start_monday(today);
        let stored = fixtures::seed_plan(&pool, monday).await;
        let (server, base) = serve_router(pool.clone(), fixtures::config()).await;
        let (status, body) = get_json(&base, "/v1/plan", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        assert_eq!(body["date"], today.format("%Y-%m-%d").to_string());
        assert!(body.get("reason").is_none());
        let signal = health_coach::plan_week(&pool, "alex", &stored, today, WeightUnit::Lb)
            .await
            .signal_text(WeightUnit::Lb);
        let plan = &body["plan"];

        assert!(signal.contains(&format!("_{}_", plan["theme"].as_str().unwrap())));
        let days = plan["days"].as_array().unwrap();
        assert_eq!(days.len(), 7);
        assert_eq!(days[0]["date"], body["week_start"]);
        for day in days {
            assert_eq!(day["is_today"], day["date"] == body["date"]);
            let notes = day["notes"].as_str().unwrap();
            let head = format!(
                "• *{}*: {}",
                day["weekday"].as_str().unwrap(),
                day["kind"].as_str().unwrap()
            );
            let head = if notes.is_empty() {
                format!("{head}\n")
            } else {
                format!("{head} — {notes}\n")
            };
            assert!(signal.contains(&head), "{head:?} not in {signal}");
            for exercise in day["exercises"].as_array().unwrap() {
                assert!(signal.contains(exercise["name"].as_str().unwrap()));
            }
        }

        let today_day = days.iter().find(|day| day["is_today"] == true).unwrap();
        let session = &plan["today"];
        assert_eq!(session["weekday"], today_day["weekday"]);
        assert_eq!(session["kind"], today_day["kind"]);
        assert!(signal.contains(&format!(
            "📌 *Today:* {}",
            session["kind"].as_str().unwrap()
        )));
        for exercise in session["exercises"].as_array().unwrap() {
            let target = &exercise["target"];
            let Some(weight) = target["weight_lb"].as_f64() else {
                continue;
            };
            let reps: Vec<String> = target["reps"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::to_string)
                .collect();
            let line = format!(
                "{} — {}×{} @ {weight} lb, aim {}",
                exercise["name"].as_str().unwrap(),
                exercise["sets"],
                exercise["reps"].as_str().unwrap(),
                reps.join("/")
            );
            assert!(signal.contains(&line), "{line:?} not in {signal}");
        }

        let progress = &plan["progress"];
        let line = health_coach::format_plan_progress_line(
            progress["sessions_matched"].as_i64().unwrap() as i32,
            progress["sessions_planned"].as_i64().unwrap() as i32,
            progress["cardio_minutes"].as_i64().unwrap() as i32,
            progress["planned_cardio_minutes"].as_i64().unwrap() as i32,
        );
        assert!(signal.contains(&line), "{line:?} not in {signal}");
        server.shutdown().await;
    }

    /// A fixed Wednesday: Monday's lifts give today's leg press a target and
    /// Monday plus Tuesday count as matched sessions.
    #[tokio::test]
    async fn plan_week_reads_targets_and_progress() {
        let (_dir, pool) = test_pool().await;
        let monday = fixtures::week_start();
        let stored = fixtures::seed_plan(&pool, monday).await;
        let week =
            health_coach::plan_week(&pool, "alex", &stored, fixtures::day(), WeightUnit::Lb).await;
        // The brief's read skips the per-exercise target queries but shows
        // the same session and progress.
        let brief = health_coach::read_plan_week(
            &pool,
            "alex",
            &stored,
            fixtures::day(),
            health_coach::PlanRead::WithoutTargets,
            WeightUnit::Lb,
        )
        .await;
        let brief_today = brief.today.as_ref().unwrap();
        assert_eq!(brief_today.day, week.today.as_ref().unwrap().day);
        assert!(brief_today.targets.iter().all(Option::is_none));
        assert_eq!(brief.progress, week.progress);
        let body = serde_json::to_value(super::PlanBody::new(
            week,
            monday,
            fixtures::day(),
            WeightUnit::Lb,
            &chotu_common::AppConfig::default(),
        ))
        .unwrap();
        assert_eq!(body["days"][2]["is_today"], true);
        assert_eq!(body["days"][2]["date"], "2025-03-12");
        assert_eq!(
            body["today"]["exercises"][0],
            json!({
                "name": "Leg press", "sets": 3, "reps": "10-12",
                "target": {"weight_lb": 190.0, "weight": 190.0, "unit": "lb", "reps": [10, 10, 10], "note": "+10 lb"},
                "media": {"type": "youtube", "video_id": "IZxyjW7MPJQ"},
            })
        );
        assert_eq!(body["today"]["exercises"][2]["target"], Value::Null);
        assert_eq!(
            body["progress"],
            json!({
                "sessions_matched": 2, "sessions_planned": 3,
                "cardio_minutes": 30, "planned_cardio_minutes": 30,
            })
        );
    }

    #[tokio::test]
    async fn kilogram_plan_targets_keep_pounds_and_add_member_weight() {
        let (_dir, pool) = test_pool().await;
        let monday = fixtures::week_start();
        let stored = fixtures::seed_plan(&pool, monday).await;
        let week =
            health_coach::plan_week(&pool, "alex", &stored, fixtures::day(), WeightUnit::Kg).await;
        let body = serde_json::to_value(super::PlanBody::new(
            week,
            monday,
            fixtures::day(),
            WeightUnit::Kg,
            &chotu_common::AppConfig::default(),
        ))
        .unwrap();
        let target = &body["today"]["exercises"][0]["target"];
        let pounds = target["weight_lb"].as_f64().unwrap();
        assert_eq!(target["unit"], "kg");
        assert!((target["weight"].as_f64().unwrap() - WeightUnit::Kg.from_lb(pounds)).abs() < 1e-9);
        assert_eq!(body["today"]["exercises"][2]["target"], Value::Null);
    }
}
