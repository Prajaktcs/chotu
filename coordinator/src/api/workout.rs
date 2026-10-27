//! Workout endpoints over the typed core in `health_coach::strength_log`.
//! Signal's `/log` uses the same core, so a workout started in one shows up in
//! the other (see `docs/app-api.md`).

use super::idempotency::Idempotency;
use super::{ApiError, Caller};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chotu_common::AppConfig;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use health_coach::{
    ExerciseSummary, Load, LoggedSet, PerformedAtError, PlanDay, PlanExercise, SetInput, Target,
    TodaysPlan, WeightUnit, WorkoutError, WorkoutState,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

/// `POST /v1/workout/sets`: one set.
#[derive(Debug, Deserialize)]
pub(super) struct LogSetRequest {
    exercise: String,
    /// Required but nullable: `null` is bodyweight.
    #[serde(deserialize_with = "Option::deserialize")]
    weight: Option<f64>,
    unit: Unit,
    reps: u32,
    /// RFC 3339 with an offset; server time when absent.
    #[serde(default)]
    performed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Unit {
    Lb,
    Kg,
}

impl From<Unit> for WeightUnit {
    fn from(unit: Unit) -> Self {
        match unit {
            Unit::Lb => Self::Lb,
            Unit::Kg => Self::Kg,
        }
    }
}

#[derive(Debug, Serialize)]
pub(super) struct WorkoutResponse {
    /// The household-timezone day this answer is for (`2026-10-24`), so the
    /// app knows which day's plan it holds without guessing from the phone.
    date: String,
    /// `null` when no workout is open today.
    workout: Option<WorkoutBody>,
    /// Today's planned lifts while no workout is open. Omitted when a workout
    /// is open (it carries the plan) and on rest days or without a plan, so
    /// those responses stay `{"workout": ...}` exactly as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    plan: Option<PlanBody>,
}

#[derive(Debug, Serialize)]
struct PlanBody {
    plan_day: Option<PlanDayBody>,
    exercises: Vec<PlannedExerciseBody>,
}

#[derive(Debug, Serialize)]
pub(super) struct SetLoggedResponse {
    set: SetBody,
    /// The workout the set joined. For a set done earlier (`performed_at`)
    /// this can be an earlier workout of that day, already closed.
    workout: WorkoutBody,
}

#[derive(Debug, Serialize)]
pub(super) struct SetDeletedResponse {
    set: SetBody,
    workout: WorkoutBody,
}

#[derive(Debug, Serialize)]
pub(super) struct WorkoutDoneResponse {
    /// Per exercise, in first-logged order.
    exercises: Vec<SummaryBody>,
}

#[derive(Debug, Serialize)]
struct WorkoutBody {
    session_id: String,
    current_exercise: Option<String>,
    plan_day: Option<PlanDayBody>,
    exercises: Vec<PlannedExerciseBody>,
    /// Oldest first.
    sets: Vec<SetBody>,
}

#[derive(Debug, Serialize)]
pub(super) struct PlanDayBody {
    weekday: String,
    kind: &'static str,
    notes: String,
}

#[derive(Debug, Serialize)]
pub(super) struct PlannedExerciseBody {
    name: String,
    sets: u32,
    reps: String,
    target: Option<TargetBody>,
}

#[derive(Debug, Serialize)]
pub(super) struct TargetBody {
    /// `null` is bodyweight.
    weight_lb: Option<f64>,
    weight: Option<f64>,
    unit: WeightUnit,
    reps: Vec<u32>,
    note: Option<String>,
}

#[derive(Debug, Serialize)]
struct SetBody {
    id: String,
    exercise: String,
    /// `null` is bodyweight.
    weight_lb: Option<f64>,
    weight: Option<f64>,
    unit: WeightUnit,
    reps: u32,
}

#[derive(Debug, Serialize)]
struct SummaryBody {
    name: String,
    sets: Vec<SetRecordBody>,
    next: Option<TargetBody>,
}

#[derive(Debug, Serialize)]
struct SetRecordBody {
    weight_lb: Option<f64>,
    weight: Option<f64>,
    unit: WeightUnit,
    reps: u32,
}

impl WorkoutBody {
    fn new(state: WorkoutState, unit: WeightUnit) -> Self {
        Self {
            session_id: state.session_id,
            current_exercise: state.current_exercise,
            plan_day: state.plan_day.map(PlanDayBody::from),
            exercises: planned_exercises(state.exercises, state.targets, unit),
            sets: state
                .sets
                .into_iter()
                .map(|set| SetBody::new(set, unit))
                .collect(),
        }
    }
}

impl PlanBody {
    /// `None` unless today has planned lifts.
    fn from_plan(plan: TodaysPlan, unit: WeightUnit) -> Option<Self> {
        if plan.exercises.is_empty() {
            return None;
        }
        Some(Self {
            plan_day: plan.plan_day.map(PlanDayBody::from),
            exercises: planned_exercises(plan.exercises, plan.targets, unit),
        })
    }
}

impl From<PlanDay> for PlanDayBody {
    fn from(day: PlanDay) -> Self {
        Self {
            weekday: day.weekday,
            kind: day.kind.as_str(),
            notes: day.notes,
        }
    }
}

pub(super) fn planned_exercises(
    exercises: Vec<PlanExercise>,
    targets: Vec<Option<Target>>,
    unit: WeightUnit,
) -> Vec<PlannedExerciseBody> {
    exercises
        .into_iter()
        .zip(targets)
        .map(|(exercise, target)| PlannedExerciseBody {
            name: exercise.name,
            sets: exercise.sets,
            reps: exercise.reps,
            target: target.map(|target| TargetBody::new(target, unit)),
        })
        .collect()
}

impl TargetBody {
    fn new(target: Target, unit: WeightUnit) -> Self {
        Self {
            weight_lb: target.weight_lb,
            weight: target.weight_lb.map(|weight| unit.from_lb(weight)),
            unit,
            reps: target.reps,
            note: target.note,
        }
    }
}

impl SetBody {
    fn new(set: LoggedSet, unit: WeightUnit) -> Self {
        Self {
            id: set.id,
            exercise: set.exercise_name,
            weight_lb: set.weight_lb,
            weight: set.weight_lb.map(|weight| unit.from_lb(weight)),
            unit,
            reps: set.reps,
        }
    }
}

impl SummaryBody {
    fn new(summary: ExerciseSummary, unit: WeightUnit) -> Self {
        Self {
            name: summary.name,
            sets: summary
                .sets
                .into_iter()
                .map(|(weight_lb, reps)| SetRecordBody {
                    weight_lb,
                    weight: weight_lb.map(|weight| unit.from_lb(weight)),
                    unit,
                    reps,
                })
                .collect(),
            next: summary.next.map(|target| TargetBody::new(target, unit)),
        }
    }
}

/// Server time in the household timezone, as the core wants it: the instant
/// and today's civil date, the same pair Signal's `/log` passes.
pub(super) fn clock(tz: Tz) -> (DateTime<Utc>, chrono::NaiveDate) {
    let now = Utc::now().with_timezone(&tz);
    (now.with_timezone(&Utc), now.date_naive())
}

/// The caller's member. `Caller` is always a linked DM, so this never fails.
pub(super) fn member_id(Caller(scope): Caller) -> Result<String, ApiError> {
    scope
        .member_id()
        .map(str::to_string)
        .ok_or(ApiError::MemberRequired)
}

pub(super) fn member_weight_unit(config: &AppConfig, member_id: &str) -> WeightUnit {
    config
        .family
        .members
        .iter()
        .find(|member| member.id == member_id)
        .map(|member| member.weight_unit)
        .unwrap_or_default()
}

fn rejected(status: StatusCode, message: impl ToString) -> ApiError {
    ApiError::Rejected(status, message.to_string())
}

impl From<WorkoutError> for ApiError {
    fn from(err: WorkoutError) -> Self {
        match err {
            WorkoutError::NoOpenWorkout => rejected(StatusCode::CONFLICT, err),
            WorkoutError::SetNotFound => rejected(StatusCode::NOT_FOUND, err),
            WorkoutError::NoPlannedLifts
            | WorkoutError::ExerciseOutOfRange { .. }
            | WorkoutError::NoCurrentExercise
            | WorkoutError::UnknownLoad { .. }
            | WorkoutError::InvalidSet(_) => rejected(StatusCode::UNPROCESSABLE_ENTITY, err),
            WorkoutError::Database { .. } | WorkoutError::Plan(_) => {
                eprintln!("api_workout failed: {err:?}");
                ApiError::Internal
            }
        }
    }
}

/// The `code` on a `422` for a set more than 7 days old. An older server may
/// already have pruned its original response, even if that send landed.
/// Successful uploads are now retained, but the app must preserve ambiguity.
const TOO_OLD_CODE: &str = "too_old";

impl From<PerformedAtError> for ApiError {
    fn from(err: PerformedAtError) -> Self {
        match err {
            PerformedAtError::TooOld => ApiError::RejectedWithCode(
                StatusCode::UNPROCESSABLE_ENTITY,
                TOO_OLD_CODE,
                err.to_string(),
            ),
            PerformedAtError::Invalid | PerformedAtError::InFuture => {
                rejected(StatusCode::UNPROCESSABLE_ENTITY, err)
            }
        }
    }
}

impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        rejected(rejection.status(), rejection.body_text())
    }
}

/// `GET /v1/workout`: today's open workout, or `{"workout": null}` plus
/// today's `plan` when lifts are planned. Never opens a workout.
pub(super) async fn get_workout(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
) -> Result<Json<WorkoutResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let unit = member_weight_unit(&config, &member_id);
    let (now, today) = clock(tz);
    let date = today.format("%Y-%m-%d").to_string();
    let response = match health_coach::workout_state(&pool, &member_id, now, today, unit).await? {
        Some(state) => WorkoutResponse {
            date,
            workout: Some(WorkoutBody::new(state, unit)),
            plan: None,
        },
        // Today's workout already happened (Done, or closed idle): no plan, so
        // the app doesn't offer "Start workout" for a second one.
        None if health_coach::has_workout_on(&pool, &member_id, today).await? => WorkoutResponse {
            date,
            workout: None,
            plan: None,
        },
        None => WorkoutResponse {
            date,
            workout: None,
            plan: PlanBody::from_plan(
                health_coach::todays_plan(&pool, &member_id, today, unit).await?,
                unit,
            ),
        },
    };
    Ok(Json(response))
}

/// `POST /v1/workout/sets`: log one set, starting today's workout if needed.
pub(super) async fn log_set(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
    body: Result<Json<LogSetRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let unit = member_weight_unit(&config, &member_id);
    let Json(body) = body?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let (now, today) = clock(tz);
                let performed_at = body
                    .performed_at
                    .as_deref()
                    .map(health_coach::parse_performed_at)
                    .transpose()?;
                let performed =
                    health_coach::resolve_performed_at(performed_at, now.with_timezone(&tz))?;
                let load = match body.weight {
                    Some(weight) => Load::Weight(WeightUnit::from(body.unit).to_lb(weight)),
                    None => Load::Bodyweight,
                };
                let set = SetInput {
                    load,
                    reps: body.reps,
                    count: 1,
                };
                let logged = health_coach::log_sets(
                    &pool,
                    &member_id,
                    now,
                    today,
                    performed,
                    Some(&body.exercise),
                    &[set],
                    unit,
                )
                .await?;
                let set = logged.logged.into_iter().next().ok_or(ApiError::Internal)?;
                Ok((
                    StatusCode::CREATED,
                    Json(SetLoggedResponse {
                        set: SetBody::new(set, unit),
                        workout: WorkoutBody::new(logged.state, unit),
                    }),
                ))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `POST /v1/workout/done`: close today's workout.
pub(super) async fn finish_workout(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let unit = member_weight_unit(&config, &member_id);
    Ok(idempotency
        .run(async move {
            let (now, today) = clock(tz);
            health_coach::close_workout(&pool, &member_id, now, today, unit)
                .await
                .map(|summary| {
                    Json(WorkoutDoneResponse {
                        exercises: summary
                            .into_iter()
                            .map(|summary| SummaryBody::new(summary, unit))
                            .collect(),
                    })
                })
                .map_err(ApiError::from)
                .into_response()
        })
        .await)
}

/// `DELETE /v1/workout/sets/{id}`: remove one of the caller's own sets,
/// including historical compensation after the upload age window. Another
/// member's or an absent set is 404. Closed workouts stay closed.
pub(super) async fn delete_set(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
    Path(set_id): Path<String>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let unit = member_weight_unit(&config, &member_id);
    Ok(idempotency
        .run(async move {
            let (now, today) = clock(tz);
            match health_coach::delete_set(&pool, &member_id, now, today, &set_id, unit).await {
                Ok(deleted) => Json(SetDeletedResponse {
                    set: SetBody::new(deleted.set, unit),
                    workout: WorkoutBody::new(deleted.state, unit),
                })
                .into_response(),
                Err(WorkoutError::NoOpenWorkout | WorkoutError::SetNotFound) => (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "set not found", "code": "set_absent" })),
                )
                    .into_response(),
                Err(err) => ApiError::from(err).into_response(),
            }
        })
        .await)
}

#[cfg(test)]
mod tests {
    use super::super::idempotency::IDEMPOTENCY_KEY;
    use super::super::tests::{
        request, set_count, test_auth_for, test_pool, ALEX_PHONE, KITCHEN_IPAD,
    };
    use super::super::{router, ApiServer, ApiState};
    use chotu_common::family::WeightUnit;
    use chrono::{Duration, FixedOffset, SecondsFormat};
    use chrono_tz::Tz;
    use serde_json::{json, Value};
    use sqlx::SqlitePool;
    use tokio::net::TcpListener;

    struct App {
        server: ApiServer,
        base: String,
        client: reqwest::Client,
    }

    async fn serve(pool: SqlitePool) -> App {
        serve_with_config(pool, crate::status::fixtures::config()).await
    }

    async fn serve_with_config(pool: SqlitePool, config: chotu_common::AppConfig) -> App {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let auth = test_auth_for(&config.family.members);
        let state = ApiState {
            pool,
            tz: Tz::UTC,
            config: std::sync::Arc::new(config),
            memory: chotu_common::MemoryIndex::with_base_url("http://127.0.0.1:0", "unused"),
        };
        let server = ApiServer::spawn(listener, router(auth, state));
        App {
            server,
            base,
            client: reqwest::Client::new(),
        }
    }

    impl App {
        /// Sends one request; writes get `key` as their `Idempotency-Key`.
        async fn call(
            &self,
            method: reqwest::Method,
            path: &str,
            (token, member): (&str, &str),
            key: Option<&str>,
            body: Option<Value>,
        ) -> (u16, Value) {
            let mut builder = request(
                &self.client,
                method,
                format!("{}{path}", self.base),
                Some(token),
                Some(member),
            );
            if let Some(key) = key {
                builder = builder.header(IDEMPOTENCY_KEY, key);
            }
            if let Some(body) = body {
                builder = builder.json(&body);
            }
            let response = builder.send().await.unwrap();
            let status = response.status().as_u16();
            (status, response.json().await.unwrap())
        }

        /// `GET /v1/workout` as sent, `date` included.
        async fn workout_raw(&self, caller: (&str, &str)) -> (u16, Value) {
            self.call(reqwest::Method::GET, "/v1/workout", caller, None, None)
                .await
        }

        /// `GET /v1/workout` without `date`, which changes with the clock.
        async fn workout(&self, caller: (&str, &str)) -> (u16, Value) {
            let (status, mut body) = self.workout_raw(caller).await;
            if status == 200 {
                let object = body.as_object_mut().unwrap();
                assert!(object.remove("date").is_some());
            }
            (status, body)
        }

        async fn log(&self, caller: (&str, &str), key: &str, body: Value) -> (u16, Value) {
            self.call(
                reqwest::Method::POST,
                "/v1/workout/sets",
                caller,
                Some(key),
                Some(body),
            )
            .await
        }

        async fn delete(&self, caller: (&str, &str), key: &str, id: &str) -> (u16, Value) {
            let path = format!("/v1/workout/sets/{id}");
            self.call(reqwest::Method::DELETE, &path, caller, Some(key), None)
                .await
        }

        async fn done(&self, key: &str) -> (u16, Value) {
            self.call(
                reqwest::Method::POST,
                "/v1/workout/done",
                ALEX,
                Some(key),
                None,
            )
            .await
        }
    }

    const ALEX: (&str, &str) = (ALEX_PHONE, "alex");
    const IPAD_ALEX: (&str, &str) = (KITCHEN_IPAD, "alex");
    const IPAD_JORDAN: (&str, &str) = (KITCHEN_IPAD, "jordan");

    fn bench(weight: f64) -> Value {
        json!({ "exercise": "bench press", "weight": weight, "unit": "lb", "reps": 8 })
    }

    /// The test server's clock (`Tz::UTC`), as Signal's `/log` would pass it.
    fn signal_clock() -> (chrono::DateTime<chrono::Utc>, chrono::NaiveDate) {
        let now = chrono::Utc::now();
        (now, now.date_naive())
    }

    /// `(exercise, weight_lb, reps)` per set in a `GET /v1/workout` body.
    fn sets(workout: &Value) -> Vec<(String, Value, u64)> {
        workout["workout"]["sets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["exercise"].as_str().unwrap().to_string(),
                    s["weight_lb"].clone(),
                    s["reps"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    /// Saves a weekly plan whose only day is today (in the test server's UTC).
    async fn plan_today(pool: &SqlitePool, member: &str, kind: health_coach::PlanDayKind) {
        let today = chrono::Utc::now().date_naive();
        let exercises = if kind == health_coach::PlanDayKind::Rest {
            vec![]
        } else {
            vec![
                health_coach::PlanExercise {
                    name: "Bench press".into(),
                    sets: 3,
                    reps: "6-8".into(),
                },
                health_coach::PlanExercise {
                    name: "Plank".into(),
                    sets: 2,
                    reps: "45s".into(),
                },
            ]
        };
        let plan = health_coach::WeeklyFitnessPlan {
            theme: "Base".into(),
            days: vec![health_coach::PlanDay {
                weekday: health_coach::weekday_name(today).into(),
                kind,
                notes: "upper".into(),
                exercises,
            }],
        };
        let week_start = health_coach::week_start_monday(today)
            .format("%Y-%m-%d")
            .to_string();
        health_coach::save_weekly_plan(pool, member, &week_start, &plan)
            .await
            .unwrap();
    }

    async fn session_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM fitness_workout_sessions")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn plan_is_returned_before_a_workout_without_opening_one() {
        let (_dir, pool) = test_pool().await;
        plan_today(&pool, "alex", health_coach::PlanDayKind::Strength).await;
        // An earlier bench session gives a target: top of 6-8 reached, so +5 lb.
        let earlier = chrono::Utc::now() - Duration::days(3);
        health_coach::log_sets(
            &pool,
            "alex",
            earlier,
            earlier.date_naive(),
            health_coach::PerformedAt::new(earlier),
            Some("bench press"),
            &[health_coach::SetInput {
                load: health_coach::Load::Weight(135.0),
                reps: 8,
                count: 3,
            }],
            WeightUnit::Lb,
        )
        .await
        .unwrap();
        health_coach::close_workout(&pool, "alex", earlier, earlier.date_naive(), WeightUnit::Lb)
            .await
            .unwrap();
        let sessions_before = session_count(&pool).await;
        let app = serve(pool.clone()).await;

        let (status, body) = app.workout(ALEX).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["workout"], Value::Null);
        let plan = &body["plan"];
        assert_eq!(plan["plan_day"]["kind"], "strength");
        assert_eq!(plan["plan_day"]["notes"], "upper");
        assert_eq!(plan["exercises"][0]["name"], "Bench press");
        assert_eq!(plan["exercises"][0]["sets"], 3);
        assert_eq!(plan["exercises"][0]["reps"], "6-8");
        assert!(
            plan["exercises"][0]["target"]["weight_lb"].is_number(),
            "{body}"
        );
        assert_eq!(plan["exercises"][1]["name"], "Plank");
        // Reading opened nothing; a repeat read is the same.
        assert_eq!(session_count(&pool).await, sessions_before);
        assert_eq!(app.workout(ALEX).await, (200, body.clone()));

        // The first set opens the workout, which then carries the same plan.
        assert_eq!(app.log(ALEX, "first", bench(140.0)).await.0, 201);
        let (_, open) = app.workout(ALEX).await;
        assert!(open.get("plan").is_none(), "{open}");
        assert_eq!(open["workout"]["plan_day"], plan["plan_day"]);
        assert_eq!(open["workout"]["exercises"], plan["exercises"]);

        // After Done, today's workout is closed: no plan, so no second workout.
        assert_eq!(app.done("done-1").await.0, 200);
        assert_eq!(app.workout(ALEX).await, (200, json!({ "workout": null })));

        // Jordan has no plan: the response is exactly the old one.
        assert_eq!(
            app.workout(IPAD_JORDAN).await,
            (200, json!({ "workout": null }))
        );

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn the_response_names_the_household_day() {
        let (_dir, pool) = test_pool().await;
        plan_today(&pool, "alex", health_coach::PlanDayKind::Rest).await;
        let app = serve(pool.clone()).await;

        let before = chrono::Utc::now().date_naive();
        let (status, body) = app.workout_raw(ALEX).await;
        let after = chrono::Utc::now().date_naive();
        assert_eq!(status, 200, "{body}");
        let date = body["date"].as_str().unwrap();
        assert!(
            [before, after]
                .iter()
                .any(|day| day.format("%Y-%m-%d").to_string() == date),
            "{body}"
        );

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn rest_day_response_is_unchanged() {
        let (_dir, pool) = test_pool().await;
        plan_today(&pool, "alex", health_coach::PlanDayKind::Rest).await;
        let app = serve(pool.clone()).await;

        assert_eq!(app.workout(ALEX).await, (200, json!({ "workout": null })));
        assert_eq!(session_count(&pool).await, 0);

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn signal_and_api_log_into_the_same_workout() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;

        let (now, today) = signal_clock();
        health_coach::log_command_reply(&pool, "alex", now, today, "bench 135x8", WeightUnit::Lb)
            .await
            .unwrap();
        let (status, workout) = app.workout(ALEX).await;
        assert_eq!(status, 200, "{workout}");
        assert_eq!(sets(&workout), vec![("Bench".to_string(), json!(135.0), 8)]);

        let squat = json!({ "exercise": "squat", "weight": 60, "unit": "kg", "reps": 5 });
        let (status, logged) = app.log(ALEX, "squat-1", squat).await;
        assert_eq!(status, 201, "{logged}");
        assert_eq!(logged["set"]["exercise"], "Squat");
        assert_eq!(logged["set"]["unit"], "lb");
        assert_eq!(logged["set"]["weight"], logged["set"]["weight_lb"]);
        assert_eq!(
            logged["workout"]["session_id"],
            workout["workout"]["session_id"]
        );

        // Signal's `/log` status lists both lifts, the kg set converted to lb.
        let (now, today) = signal_clock();
        let status_text =
            health_coach::log_command_reply(&pool, "alex", now, today, "", WeightUnit::Lb)
                .await
                .unwrap();
        assert!(
            status_text.starts_with("▶️ Workout resumed"),
            "{status_text}"
        );
        assert!(status_text.contains("Bench  ✓ 135 lb × 8"), "{status_text}");
        assert!(
            status_text.contains("Squat  ✓ 132.3 lb × 5"),
            "{status_text}"
        );

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn members_cannot_read_write_or_delete_each_others_sets() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;

        let (status, logged) = app.log(ALEX, "a-1", bench(135.0)).await;
        assert_eq!(status, 201, "{logged}");
        let alex_set = logged["set"]["id"].as_str().unwrap().to_string();

        // Jordan, on the shared iPad, sees no workout and cannot delete Alex's set.
        assert_eq!(
            app.workout(IPAD_JORDAN).await,
            (200, json!({ "workout": null }))
        );
        let (status, body) = app.delete(IPAD_JORDAN, "j-1", &alex_set).await;
        assert_eq!(status, 404, "{body}");
        assert_eq!(set_count(&pool, "alex").await, 1);

        // Jordan's own set stays Jordan's.
        let (status, jordan) = app.log(IPAD_JORDAN, "j-2", bench(95.0)).await;
        assert_eq!(status, 201, "{jordan}");
        assert_eq!(set_count(&pool, "jordan").await, 1);
        let (_, alex_view) = app.workout(IPAD_ALEX).await;
        assert_eq!(
            sets(&alex_view),
            vec![("Bench press".to_string(), json!(135.0), 8)]
        );
        let jordan_set = jordan["set"]["id"].as_str().unwrap();
        let (status, _) = app.delete(ALEX, "a-2", jordan_set).await;
        assert_eq!(status, 404);
        assert_eq!(set_count(&pool, "jordan").await, 1);

        // Alex's phone may not act as Jordan at all.
        let as_jordan = (ALEX_PHONE, "jordan");
        assert_eq!(app.workout(as_jordan).await.0, 403);
        assert_eq!(app.log(as_jordan, "x-1", bench(95.0)).await.0, 403);
        assert_eq!(app.delete(as_jordan, "x-2", jordan_set).await.0, 403);

        // Alex deletes her own set from either of her devices.
        let (status, deleted) = app.delete(IPAD_ALEX, "a-3", &alex_set).await;
        assert_eq!(status, 200, "{deleted}");
        assert_eq!(deleted["set"]["id"], alex_set.as_str());
        assert_eq!(deleted["workout"]["sets"], json!([]));
        assert_eq!(set_count(&pool, "alex").await, 0);
        assert_eq!(set_count(&pool, "jordan").await, 1);

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn set_performed_two_hours_ago_lands_at_that_time() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;

        let at = chrono::Utc::now() - Duration::hours(2);
        let ist = FixedOffset::east_opt(5 * 3600 + 1800).unwrap();
        let mut body = bench(135.0);
        body["performed_at"] = json!(at
            .with_timezone(&ist)
            .to_rfc3339_opts(SecondsFormat::Secs, false));
        let (status, logged) = app.log(ALEX, "late-1", body).await;
        assert_eq!(status, 201, "{logged}");

        let (created_at, date): (String, String) =
            sqlx::query_as("SELECT created_at, date FROM fitness_set_log WHERE id = ?")
                .bind(logged["set"]["id"].as_str().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(created_at, at.format("%Y-%m-%d %H:%M:%S").to_string());
        // The civil day is in the household timezone (UTC here), not the offset sent.
        assert_eq!(date, at.date_naive().format("%Y-%m-%d").to_string());

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn bad_performed_at_or_set_fields_are_rejected() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;
        let now = chrono::Utc::now();

        // Only "too old" has a code: the app keys "may still be saved" off it.
        for (key, performed_at, expected) in [
            (
                "future",
                (now + Duration::minutes(10)).to_rfc3339(),
                json!({ "error": "performed_at is more than 5 minutes in the future" }),
            ),
            (
                "stale",
                (now - Duration::days(8)).to_rfc3339(),
                json!({ "error": "performed_at is more than 7 days old", "code": "too_old" }),
            ),
            (
                "no-offset",
                now.format("%Y-%m-%dT%H:%M:%S").to_string(),
                json!({ "error": "performed_at must be an RFC 3339 timestamp with an offset" }),
            ),
        ] {
            let mut body = bench(135.0);
            body["performed_at"] = json!(performed_at);
            let response = app.log(ALEX, key, body.clone()).await;
            assert_eq!(response, (422, expected.clone()), "{key}");
            // A replay gets the stored body, code included.
            assert_eq!(app.log(ALEX, key, body).await, (422, expected), "{key}");
        }

        let bad_bodies = [
            json!({ "exercise": "bench", "weight": 135, "unit": "stone", "reps": 8 }),
            json!({ "exercise": "bench", "weight": 135, "reps": 8 }),
            json!({ "exercise": "bench", "unit": "lb", "reps": 8 }),
            json!({ "exercise": "bench", "weight": 135, "unit": "lb", "reps": 0 }),
            json!({ "exercise": "bench", "weight": 700, "unit": "kg", "reps": 8 }),
            json!({ "exercise": "  ", "weight": 135, "unit": "lb", "reps": 8 }),
        ];
        for (i, body) in bad_bodies.into_iter().enumerate() {
            let (status, response) = app.log(ALEX, &format!("bad-{i}"), body.clone()).await;
            assert_eq!(status, 422, "{body} -> {response}");
            assert!(response["error"].is_string(), "{response}");
        }
        assert_eq!(set_count(&pool, "alex").await, 0);

        // `weight: null` is bodyweight.
        let pullups = json!({ "exercise": "pull-ups", "weight": null, "unit": "lb", "reps": 6 });
        let (status, logged) = app.log(ALEX, "bw", pullups).await;
        assert_eq!(status, 201, "{logged}");
        assert_eq!(logged["set"]["weight_lb"], Value::Null);
        assert_eq!(logged["set"]["weight"], Value::Null);
        assert_eq!(logged["set"]["unit"], "lb");

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn repeated_set_request_logs_one_set() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;

        let first = app.log(ALEX, "same-key", bench(135.0)).await;
        assert_eq!(first.0, 201, "{first:?}");
        let retry = app.log(IPAD_ALEX, "same-key", bench(135.0)).await;
        assert_eq!(retry, first);
        assert_eq!(set_count(&pool, "alex").await, 1);

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn historical_compensation_recovers_expired_upload_response_and_enforces_member_scope() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;
        let mut body = bench(135.0);
        body["performed_at"] = json!((chrono::Utc::now() - Duration::days(6)).to_rfc3339());
        let first = app.log(ALEX, "offline-original", body.clone()).await;
        assert_eq!(first.0, 201, "{first:?}");
        let set_id = first.1["set"]["id"].as_str().unwrap();
        let session_id = first.1["workout"]["session_id"].as_str().unwrap();

        // Model a delivered response lost for longer than generic retention,
        // and compensation arriving after the performed-date upload window.
        sqlx::query("UPDATE api_write_requests SET created_at = ? WHERE member_id = 'alex' AND request_id = 'offline-original'")
            .bind((chrono::Utc::now() - Duration::days(30)).to_rfc3339_opts(SecondsFormat::Secs, true))
            .execute(&pool).await.unwrap();
        let historical_date = (chrono::Utc::now() - Duration::days(30))
            .date_naive()
            .to_string();
        sqlx::query("UPDATE fitness_workout_sessions SET date = ? WHERE id = ?")
            .bind(&historical_date)
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE fitness_set_log SET date = ? WHERE id = ?")
            .bind(&historical_date)
            .bind(set_id)
            .execute(&pool)
            .await
            .unwrap();

        // Retry from either authorized device recovers the exact original id.
        assert_eq!(
            app.log(IPAD_ALEX, "offline-original", body.clone()).await,
            first
        );
        assert_eq!(set_count(&pool, "alex").await, 1);
        // The same key in another profile is not a recovery oracle.
        let jordan = app.log(IPAD_JORDAN, "offline-original", body).await;
        assert_eq!(jordan.0, 201, "{jordan:?}");
        assert_ne!(jordan.1["set"]["id"], set_id);
        assert_eq!(
            app.delete(IPAD_JORDAN, "cross-profile", set_id).await,
            (
                404,
                json!({ "error": "set not found", "code": "set_absent" })
            )
        );
        assert_eq!(set_count(&pool, "alex").await, 1);

        let deleted = app.delete(IPAD_ALEX, "recover-owned", set_id).await;
        assert_eq!(deleted.0, 200, "{deleted:?}");
        assert_eq!(deleted.1["set"]["id"], set_id);
        assert_eq!(set_count(&pool, "alex").await, 0);
        assert_eq!(set_count(&pool, "jordan").await, 1);
        assert_eq!(app.delete(ALEX, "recover-owned", set_id).await, deleted);
        assert_eq!(
            app.delete(ALEX, "confirm-absence", set_id).await,
            (
                404,
                json!({ "error": "set not found", "code": "set_absent" })
            )
        );
        let closed: Option<String> =
            sqlx::query_scalar("SELECT closed_at FROM fitness_workout_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(closed.is_some());
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn lost_undo_confirmation_replays_after_retention_without_leaking_between_members() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool.clone()).await;
        let (status, logged) = app.log(ALEX, "upload-before-recovery", bench(135.0)).await;
        assert_eq!(status, 201, "{logged}");
        let set_id = logged["set"]["id"].as_str().unwrap();
        let confirmed = app.delete(ALEX, "manual-recovery-delete", set_id).await;
        assert_eq!(confirmed.0, 200, "{confirmed:?}");
        assert_eq!(set_count(&pool, "alex").await, 0);

        // The phone missed this successful reply and stayed offline beyond
        // generic response retention. Age its response, not its set identity.
        sqlx::query(
            "UPDATE api_write_requests SET created_at = ? \
             WHERE member_id = 'alex' AND request_id = 'manual-recovery-delete'",
        )
        .bind((chrono::Utc::now() - Duration::days(30)).to_rfc3339_opts(SecondsFormat::Secs, true))
        .execute(&pool)
        .await
        .unwrap();
        // Another profile's write triggers real pruning but cannot retrieve
        // the successful owned DELETE response under the same request key.
        assert_eq!(
            app.delete(IPAD_JORDAN, "manual-recovery-delete", set_id)
                .await,
            (
                404,
                json!({ "error": "set not found", "code": "set_absent" })
            )
        );
        assert_eq!(
            app.delete(IPAD_ALEX, "manual-recovery-delete", set_id)
                .await,
            confirmed
        );
        // A fresh key still sees true absence; only the original key replays
        // the durable confirmation needed by manually recovered compensation.
        assert_eq!(
            app.delete(ALEX, "fresh-absence-check", set_id).await,
            (
                404,
                json!({ "error": "set not found", "code": "set_absent" })
            )
        );
        assert_eq!(set_count(&pool, "alex").await, 0);
        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn done_closes_the_workout_and_summarizes_it() {
        let (_dir, pool) = test_pool().await;
        let app = serve(pool).await;

        assert_eq!(app.log(ALEX, "s-1", bench(135.0)).await.0, 201);
        assert_eq!(app.log(ALEX, "s-2", bench(140.0)).await.0, 201);
        let (status, summary) = app.done("done-1").await;
        assert_eq!(status, 200, "{summary}");
        assert_eq!(
            summary,
            json!({ "exercises": [{
                "name": "Bench press",
                "sets": [
                    { "weight_lb": 135.0, "weight": 135.0, "unit": "lb", "reps": 8 },
                    { "weight_lb": 140.0, "weight": 140.0, "unit": "lb", "reps": 8 },
                ],
                "next": null,
            }] })
        );
        assert_eq!(app.workout(ALEX).await, (200, json!({ "workout": null })));
        // A retry replays the summary; a new request finds nothing open.
        assert_eq!(app.done("done-1").await, (200, summary));
        assert_eq!(
            app.done("done-2").await,
            (409, json!({ "error": "no workout in progress" }))
        );

        app.server.shutdown().await;
    }

    #[tokio::test]
    async fn member_units_are_returned_recursively_while_storage_stays_in_pounds() {
        for unit in [WeightUnit::Kg, WeightUnit::Lb] {
            let (_dir, pool) = test_pool().await;
            let mut config = crate::status::fixtures::config();
            config
                .family
                .members
                .iter_mut()
                .find(|member| member.id == "alex")
                .unwrap()
                .weight_unit = unit;
            plan_today(&pool, "alex", health_coach::PlanDayKind::Strength).await;
            let earlier = chrono::Utc::now() - Duration::days(3);
            health_coach::log_sets(
                &pool,
                "alex",
                earlier,
                earlier.date_naive(),
                health_coach::PerformedAt::new(earlier),
                Some("bench press"),
                &[health_coach::SetInput {
                    load: health_coach::Load::Weight(unit.to_lb(60.0)),
                    reps: 8,
                    count: 3,
                }],
                unit,
            )
            .await
            .unwrap();
            health_coach::close_workout(&pool, "alex", earlier, earlier.date_naive(), unit)
                .await
                .unwrap();

            let app = serve_with_config(pool.clone(), config).await;
            let (status, me) = app
                .call(reqwest::Method::GET, "/v1/me", ALEX, None, None)
                .await;
            assert_eq!(status, 200, "{me}");
            assert_eq!(me["member"]["weight_unit"], unit.as_str());
            assert_eq!(me["profiles"][0]["weight_unit"], unit.as_str());
            let (status, health) = app
                .call(reqwest::Method::GET, "/v1/status", ALEX, None, None)
                .await;
            assert_eq!(status, 200, "{health}");
            assert_eq!(health["member"]["weight_unit"], unit.as_str());
            let (_, planned) = app.workout(ALEX).await;
            let target = &planned["plan"]["exercises"][0]["target"];
            assert_member_weight(target, unit);
            let (status, plan) = app
                .call(reqwest::Method::GET, "/v1/plan", ALEX, None, None)
                .await;
            assert_eq!(status, 200, "{plan}");
            assert_eq!(plan["plan"]["today"]["exercises"][0]["target"], *target);

            let body = json!({
                "exercise": "bench press", "weight": 60.0, "unit": unit.as_str(), "reps": 8,
            });
            let (status, logged) = app.log(ALEX, "unit-set", body.clone()).await;
            assert_eq!(status, 201, "{logged}");
            let id = logged["set"]["id"].as_str().unwrap();
            let stored: f64 =
                sqlx::query_scalar("SELECT weight_lb FROM fitness_set_log WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let expected_lb = if unit == WeightUnit::Kg {
                132.2773572
            } else {
                60.0
            };
            assert!((stored - expected_lb).abs() < 0.001, "{stored}");
            assert_eq!(logged["set"]["weight_lb"].as_f64().unwrap(), stored);
            for set in [&logged["set"], &logged["workout"]["sets"][0]] {
                assert_member_weight(set, unit);
                assert!(
                    (set["weight"].as_f64().unwrap() - 60.0).abs() < 1e-9,
                    "{set}"
                );
            }
            assert_eq!(logged["workout"]["exercises"][0]["target"], *target);
            let (_, workout) = app.workout(ALEX).await;
            assert_eq!(workout["workout"]["sets"][0], logged["set"]);
            let (status, deleted) = app.delete(ALEX, "unit-delete", id).await;
            assert_eq!(status, 200, "{deleted}");
            assert_eq!(deleted["set"], logged["set"]);
            assert_member_weight(&deleted["workout"]["exercises"][0]["target"], unit);
            assert_eq!(app.log(ALEX, "unit-relog", body).await.0, 201);
            let (status, summary) = app.done("unit-done").await;
            assert_eq!(status, 200, "{summary}");
            let set = &summary["exercises"][0]["sets"][0];
            assert_member_weight(set, unit);
            assert_eq!(set["weight_lb"].as_f64().unwrap(), stored);
            assert!(
                (set["weight"].as_f64().unwrap() - 60.0).abs() < 1e-9,
                "{set}"
            );
            assert_member_weight(&summary["exercises"][0]["next"], unit);
            app.server.shutdown().await;
        }
    }

    fn assert_member_weight(body: &Value, unit: WeightUnit) {
        assert_eq!(body["unit"], unit.as_str(), "{body}");
        let pounds = body["weight_lb"].as_f64().unwrap();
        assert!(
            (body["weight"].as_f64().unwrap() - unit.from_lb(pounds)).abs() < 1e-9,
            "{body}"
        );
    }
}
