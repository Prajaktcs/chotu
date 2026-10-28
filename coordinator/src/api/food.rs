//! Food endpoints: list a day's meals, add one, edit one, delete one. Inserts,
//! revisions and deletions go through the same `health_coach` operations as
//! Signal's `/food`, meal-reply corrections and undo (see `docs/app-api.md`).

use super::idempotency::Idempotency;
use super::workout::member_id;
use super::{ApiError, Caller};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chotu_common::{AppConfig, FoodLog, GeminiClient, NutritionEstimation};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/food.rs"]
pub(super) mod fixture_examples;

/// Longer than any real meal description; keeps prompts and rows bounded.
const MAX_DESCRIPTION_CHARS: usize = 500;

/// The `code` on a `409` when the meal was revised since the app loaded it.
const MEAL_CHANGED_CODE: &str = "meal_changed";

#[derive(Debug, Deserialize)]
pub(super) struct DayQuery {
    /// `YYYY-MM-DD` in the household timezone; today when absent.
    date: Option<String>,
}

/// `GET /v1/food` and every food write: one household-timezone day's meals.
#[derive(Debug, Serialize)]
pub(super) struct FoodDayResponse {
    date: String,
    /// Oldest first.
    meals: Vec<MealBody>,
}

#[derive(Debug, Serialize)]
struct MealBody {
    id: String,
    /// Sent back on edit, so a meal changed elsewhere is not overwritten.
    revision: i64,
    /// When it was eaten, RFC 3339 UTC.
    eaten_at: DateTime<Utc>,
    description: String,
    calories: i32,
    protein_g: f64,
    carbs_g: f64,
    fat_g: f64,
}

/// `POST /v1/food`.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct AddMealRequest {
    description: String,
    /// `YYYY-MM-DD`; today or earlier.
    date: String,
}

/// `PATCH /v1/food/{id}`: the replacement description, re-estimated.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct EditMealRequest {
    description: String,
    revision: i64,
}

#[derive(sqlx::FromRow)]
struct MealRow {
    id: String,
    revision: i64,
    timestamp: DateTime<Utc>,
    raw_text_description: String,
    estimated_calories: i32,
    estimated_protein: f64,
    estimated_carbs: f64,
    estimated_fats: f64,
}

impl From<MealRow> for MealBody {
    fn from(row: MealRow) -> Self {
        Self {
            id: row.id,
            revision: row.revision,
            eaten_at: row.timestamp,
            description: row.raw_text_description,
            calories: row.estimated_calories,
            protein_g: row.estimated_protein,
            carbs_g: row.estimated_carbs,
            fat_g: row.estimated_fats,
        }
    }
}

impl From<QueryRejection> for ApiError {
    fn from(rejection: QueryRejection) -> Self {
        rejected(rejection.status(), rejection.body_text())
    }
}

fn rejected(status: StatusCode, message: impl ToString) -> ApiError {
    ApiError::Rejected(status, message.to_string())
}

fn internal(error: anyhow::Error) -> ApiError {
    eprintln!("api_food failed: {error:?}");
    ApiError::Internal
}

fn today(config: &AppConfig) -> NaiveDate {
    Utc::now().with_timezone(&config.resolved_tz()).date_naive()
}

/// A `YYYY-MM-DD` that is not after today.
fn past_or_today(config: &AppConfig, date: &str) -> Result<NaiveDate, ApiError> {
    let day = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| rejected(StatusCode::UNPROCESSABLE_ENTITY, "date must be YYYY-MM-DD"))?;
    if day > today(config) {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            "date is in the future",
        ));
    }
    Ok(day)
}

fn description(raw: &str) -> Result<&str, ApiError> {
    let text = raw.trim();
    if text.is_empty() || text.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("description must be 1-{MAX_DESCRIPTION_CHARS} characters"),
        ));
    }
    Ok(text)
}

/// Nothing is written before this, so a failure is a retryable 5xx.
async fn estimate(gemini: &GeminiClient, text: &str) -> Result<NutritionEstimation, ApiError> {
    gemini.approximate_nutrition(text).await.map_err(|error| {
        eprintln!("api_food nutrition estimate failed: {error:?}");
        rejected(StatusCode::BAD_GATEWAY, "nutrition estimate failed")
    })
}

/// Meals still being deleted are hidden; they finish on the next sync.
async fn day(
    pool: &SqlitePool,
    config: &AppConfig,
    member_id: &str,
    date: NaiveDate,
) -> Result<FoodDayResponse, ApiError> {
    let date = date.format("%Y-%m-%d").to_string();
    let (start, end) =
        chotu_common::civil_day_bounds_utc(&date, config.resolved_tz()).map_err(internal)?;
    let meals: Vec<MealRow> = sqlx::query_as(
        "SELECT f.id, COALESCE(c.revision, 0) AS revision, f.timestamp, f.raw_text_description, \
         f.estimated_calories, f.estimated_protein, f.estimated_carbs, f.estimated_fats \
         FROM food_log f LEFT JOIN food_log_corrections c ON c.food_log_id = f.id \
         WHERE f.family_member_id = ? \
         AND julianday(f.timestamp) >= julianday(?) AND julianday(f.timestamp) < julianday(?) \
         AND NOT EXISTS (SELECT 1 FROM food_log_deletion_intents d WHERE d.food_log_id = f.id) \
         ORDER BY julianday(f.timestamp), f.id",
    )
    .bind(member_id)
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await
    .map_err(|error| internal(error.into()))?;
    Ok(FoodDayResponse {
        date,
        meals: meals.into_iter().map(MealBody::from).collect(),
    })
}

/// The caller's own meal; another member's id looks absent.
async fn owned_meal(pool: &SqlitePool, member_id: &str, id: &str) -> Result<FoodLog, ApiError> {
    sqlx::query_as("SELECT * FROM food_log WHERE id = ? AND family_member_id = ?")
        .bind(id)
        .bind(member_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| internal(error.into()))?
        .ok_or_else(|| rejected(StatusCode::NOT_FOUND, "meal not found"))
}

fn civil_date(config: &AppConfig, log: &FoodLog) -> NaiveDate {
    log.timestamp
        .with_timezone(&config.resolved_tz())
        .date_naive()
}

/// `GET /v1/food?date=YYYY-MM-DD`: the caller's meals on that day.
pub(super) async fn get_food(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    query: Result<Query<DayQuery>, QueryRejection>,
) -> Result<Json<FoodDayResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let Query(query) = query?;
    let date = match query.date.as_deref() {
        Some(date) => past_or_today(&config, date)?,
        None => today(&config),
    };
    Ok(Json(day(&pool, &config, &member_id, date).await?))
}

/// `POST /v1/food`: estimate a described meal and log it on `date`.
pub(super) async fn add_meal(
    idempotency: Idempotency,
    caller: Caller,
    State(state): State<super::ApiState>,
    body: Result<Json<AddMealRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    let text = description(&body.description)?.to_string();
    let date = past_or_today(&state.config, &body.date)?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let config = &state.config;
                let est = estimate(&state.gemini, &text).await?;
                // Today without a meal word is "now"; an earlier day is its noon.
                let timing = chotu_common::resolve_food_log_timing_tz(
                    Some(&date.format("%Y-%m-%d").to_string()),
                    chotu_common::effective_food_time(&text, None).as_deref(),
                    config.resolved_tz(),
                );
                let log_id = uuid::Uuid::new_v4().to_string();
                let assigned = chotu_common::assign_food_tags(&est.tags, &text);
                health_coach::insert_food_log(
                    &state.pool,
                    &log_id,
                    timing.timestamp,
                    &member_id,
                    &text,
                    &est,
                    &timing.date,
                    &assigned,
                    None,
                )
                .await
                .map_err(internal)?;
                push_new_meal(&state.pool, config, &member_id, &log_id).await;
                let date = NaiveDate::parse_from_str(&timing.date, "%Y-%m-%d")
                    .map_err(|error| internal(error.into()))?;
                Ok((
                    StatusCode::CREATED,
                    Json(day(&state.pool, config, &member_id, date).await?),
                ))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// Best effort, like Signal: a failed push stays pending for the next sync.
async fn push_new_meal(pool: &SqlitePool, config: &AppConfig, member_id: &str, log_id: &str) {
    if !health_coach::member_health_credentials_configured(member_id, config) {
        return;
    }
    let pushed = async {
        let client = health_coach::google_health_client_for_member(member_id, config)?;
        let log: FoodLog = sqlx::query_as("SELECT * FROM food_log WHERE id = ?")
            .bind(log_id)
            .fetch_one(pool)
            .await?;
        health_coach::push_food_log_to_google(pool, &client, &log).await
    }
    .await;
    if let Err(error) = pushed {
        eprintln!("api_food: Google Health push pending for {log_id}: {error:?}");
    }
}

/// `PATCH /v1/food/{id}`: replace a meal's description and re-estimate it,
/// keeping its time. Signal meals keep their conversation facts current, so a
/// later reply correction builds on this edit.
pub(super) async fn edit_meal(
    idempotency: Idempotency,
    caller: Caller,
    State(state): State<super::ApiState>,
    Path(id): Path<String>,
    body: Result<Json<EditMealRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    let text = description(&body.description)?.to_string();
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let config = &state.config;
                let log = owned_meal(&state.pool, &member_id, &id).await?;
                let stale = || {
                    ApiError::RejectedWithCode(
                        StatusCode::CONFLICT,
                        MEAL_CHANGED_CODE,
                        "meal changed since it was loaded".into(),
                    )
                };
                let current = health_coach::food_log_revision(&state.pool, &id)
                    .await
                    .map_err(internal)?;
                if current != body.revision {
                    return Err(stale());
                }
                let est = estimate(&state.gemini, &text).await?;
                let signal: Option<(String, String, String, String)> = sqlx::query_as(
                    "SELECT recipient_kind, recipient_id, sender_aci, user_facts \
                     FROM food_signal_context WHERE food_log_id = ?",
                )
                .bind(&id)
                .fetch_optional(&state.pool)
                .await
                .map_err(|error| internal(error.into()))?;
                let facts = signal
                    .as_ref()
                    .map(|(.., facts)| format!("{facts}\nCorrection: the meal is {text}"));
                let context = signal.as_ref().zip(facts.as_deref()).map(
                    |((kind, recipient, sender, _), facts)| chotu_common::FoodSignalContext {
                        recipient_kind: kind,
                        recipient_id: recipient,
                        sender_aci: sender,
                        user_facts: facts,
                    },
                );
                health_coach::revise_food_log(
                    &state.pool,
                    config,
                    &log,
                    body.revision,
                    &text,
                    &est,
                    &text,
                    context.as_ref(),
                )
                .await
                .map_err(|error| {
                    // The revision CAS lost to a concurrent change or deletion.
                    if error.to_string().contains("stale") {
                        stale()
                    } else {
                        internal(error)
                    }
                })?;
                if health_coach::member_health_credentials_configured(&member_id, config) {
                    if let Err(error) =
                        health_coach::sync_corrected_food_log(&state.pool, config, &id).await
                    {
                        eprintln!("api_food: corrected meal sync pending for {id}: {error:?}");
                    }
                }
                let date = civil_date(config, &log);
                Ok(Json(day(&state.pool, config, &member_id, date).await?))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `DELETE /v1/food/{id}`: remove a meal from its day's totals and Google Health.
/// If remote cleanup fails the deletion stays recorded; a retry or the next
/// sync finishes it.
pub(super) async fn delete_meal(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let log = owned_meal(&pool, &member_id, &id).await?;
                let date = civil_date(&config, &log);
                health_coach::delete_food_logs_for_day(
                    &pool,
                    &config,
                    &member_id,
                    &date.format("%Y-%m-%d").to_string(),
                    &[id],
                )
                .await
                .map_err(|error| {
                    eprintln!("api_food delete pending: {error:?}");
                    rejected(StatusCode::BAD_GATEWAY, "meal deletion is still pending")
                })?;
                Ok(Json(day(&pool, &config, &member_id, date).await?))
            }
            .await;
            result.into_response()
        })
        .await)
}

#[cfg(test)]
mod tests {
    use super::super::idempotency::IDEMPOTENCY_KEY;
    use super::super::tests::{
        get_json, request, serve_router, serve_router_with_clients, test_pool, ALEX_PHONE,
    };
    use super::super::ApiServer;
    use super::*;
    use crate::status::fixtures;
    use reqwest::Method;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A Gemini stand-in that answers every request with one 300 kcal estimate.
    async fn gemini() -> GeminiClient {
        let nutrition = json!({
            "total_calories": 300, "protein_grams": 20, "carbs_grams": 30, "fats_grams": 10,
            "dominant_macro": "carbs", "reasoning": "fixture",
            "omega_3_dha_mg": 0, "cholesterol_mg": 0, "saturated_fat_g": 0, "unsaturated_fat_g": 0,
            "triglycerides_mg": 0, "iron_mg": 0, "vitamin_b_mg": 0, "vitamin_c_mg": 0,
            "sugar_g": 0, "fiber_g": 0, "sodium_mg": 0, "potassium_mg": 0, "calcium_mg": 0,
            "magnesium_mg": 0, "zinc_mg": 0, "vitamin_a_mcg": 0, "vitamin_d_mcg": 0,
            "vitamin_e_mg": 0, "vitamin_k_mcg": 0, "caffeine_mg": 0, "trans_fat_g": 0,
            "tags": []
        });
        let body = json!({
            "responseId": "test",
            "candidates": [{"content": {"role": "model", "parts": [{
                "functionCall": {"name": "submit", "args": nutrition}
            }]}, "finishReason": "STOP"}]
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let body = body.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    loop {
                        let n = stream.read(&mut buffer).await.unwrap();
                        request.extend_from_slice(&buffer[..n]);
                        let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        let length = std::str::from_utf8(&request[..end])
                            .unwrap()
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if n == 0 || request.len() >= end + 4 + length {
                            break;
                        }
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        GeminiClient::with_base_url("gemini-test".into(), base)
    }

    async fn write(
        base: &str,
        method: Method,
        path: &str,
        key: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let client = reqwest::Client::new();
        let mut builder = request(
            &client,
            method,
            format!("{base}{path}"),
            Some(ALEX_PHONE),
            Some("alex"),
        )
        .header(IDEMPOTENCY_KEY, key);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let response = builder.send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }

    async fn insert(pool: &SqlitePool, id: &str, member: &str, at: &str, calories: i32) {
        sqlx::query(
            "INSERT INTO food_log (id, timestamp, family_member_id, raw_text_description, \
             estimated_calories, estimated_protein, estimated_carbs, estimated_fats) \
             VALUES (?, ?, ?, ?, ?, 10, 20, 5)",
        )
        .bind(id)
        .bind(at.parse::<DateTime<Utc>>().unwrap())
        .bind(member)
        .bind(format!("meal {id}"))
        .bind(calories)
        .execute(pool)
        .await
        .unwrap();
    }

    fn date_of(config: &AppConfig, offset_days: i64) -> String {
        (today(config) - chrono::Duration::days(offset_days))
            .format("%Y-%m-%d")
            .to_string()
    }

    fn noon_utc(config: &AppConfig, date: &str) -> String {
        chotu_common::resolve_food_log_timing_tz(Some(date), Some("12:00"), config.resolved_tz())
            .timestamp
            .to_rfc3339()
    }

    #[tokio::test]
    async fn lists_only_the_callers_meals_on_the_requested_day() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let yesterday = date_of(&config, 1);
        let at = noon_utc(&config, &yesterday);
        insert(&pool, "mine", "alex", &at, 400).await;
        insert(&pool, "theirs", "jordan", &at, 500).await;
        insert(
            &pool,
            "other-day",
            "alex",
            &noon_utc(&config, &date_of(&config, 2)),
            600,
        )
        .await;
        sqlx::query(
            "INSERT INTO food_log_deletion_intents (food_log_id, family_member_id, civil_date, original_timestamp, revision) \
             SELECT 'deleting', 'alex', ?, ?, 0",
        )
        .bind(&yesterday)
        .bind(&at)
        .execute(&pool)
        .await
        .unwrap();
        insert(&pool, "deleting", "alex", &at, 700).await;
        let (server, base) = serve_router(pool, config.clone()).await;

        assert_eq!(
            get_json(&base, "/v1/food", Some(ALEX_PHONE), None).await.0,
            400
        );
        let (status, body) = get_json(
            &base,
            &format!("/v1/food?date={yesterday}"),
            Some(ALEX_PHONE),
            Some("alex"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["date"], yesterday);
        let meals = body["meals"].as_array().unwrap();
        assert_eq!(meals.len(), 1);
        assert_eq!(meals[0]["id"], "mine");
        assert_eq!(meals[0]["revision"], 0);
        assert_eq!(meals[0]["calories"], 400);

        let (status, body) = get_json(&base, "/v1/food", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        assert_eq!(body["date"], date_of(&config, 0));
        assert_eq!(body["meals"], json!([]));

        let tomorrow = date_of(&config, -1);
        for date in [tomorrow.as_str(), "yesterday"] {
            let path = format!("/v1/food?date={date}");
            assert_eq!(
                get_json(&base, &path, Some(ALEX_PHONE), Some("alex"))
                    .await
                    .0,
                422
            );
        }
        server.shutdown().await;
    }

    #[tokio::test]
    async fn adds_a_meal_on_an_earlier_day_and_updates_its_totals() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let llm = chotu_common::ChotuLlm::new("http://127.0.0.1", 0, "unused");
        let (server, base) =
            serve_router_with_clients(pool.clone(), config.clone(), llm, gemini().await).await;
        let yesterday = date_of(&config, 1);

        let (status, _) = write(
            &base,
            Method::POST,
            "/v1/food",
            "add-blank",
            Some(json!({"description": "  ", "date": yesterday})),
        )
        .await;
        assert_eq!(status, 422);

        let (status, body) = write(
            &base,
            Method::POST,
            "/v1/food",
            "add-1",
            Some(json!({"description": "dal and rice", "date": yesterday})),
        )
        .await;
        assert_eq!(status, 201);
        assert_eq!(body["date"], yesterday);
        let meals = body["meals"].as_array().unwrap();
        assert_eq!(meals.len(), 1);
        assert_eq!(meals[0]["description"], "dal and rice");
        assert_eq!(meals[0]["calories"], 300);
        assert_eq!(
            meals[0]["eaten_at"]
                .as_str()
                .unwrap()
                .parse::<DateTime<Utc>>()
                .unwrap()
                .to_rfc3339(),
            noon_utc(&config, &yesterday)
        );

        // A replay returns the stored answer instead of logging a second meal.
        let (status, replay) = write(
            &base,
            Method::POST,
            "/v1/food",
            "add-1",
            Some(json!({"description": "dal and rice", "date": yesterday})),
        )
        .await;
        assert_eq!((status, &replay), (201, &body));
        let summary: i64 = sqlx::query_scalar(
            "SELECT total_calories_ingested FROM health_family_summary WHERE family_member_id = 'alex' AND date = ?",
        )
        .bind(&yesterday)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(summary, 300);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn edits_re_estimate_keep_signal_facts_and_refuse_stale_revisions() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let date = date_of(&config, 0);
        insert(
            &pool,
            "signal-meal",
            "alex",
            &noon_utc(&config, &date_of(&config, 1)),
            500,
        )
        .await;
        insert(
            &pool,
            "jordan-meal",
            "jordan",
            &noon_utc(&config, &date),
            500,
        )
        .await;
        chotu_common::write_food_signal_context(
            &pool,
            "signal-meal",
            &chotu_common::FoodSignalContext {
                recipient_kind: "direct",
                recipient_id: "aci-alex",
                sender_aci: "aci-alex",
                user_facts: "paneer curry",
            },
        )
        .await
        .unwrap();
        let llm = chotu_common::ChotuLlm::new("http://127.0.0.1", 0, "unused");
        let (server, base) =
            serve_router_with_clients(pool.clone(), config.clone(), llm, gemini().await).await;

        let edit = |revision: i64| json!({"description": "tofu curry", "revision": revision});
        let (status, _) = write(
            &base,
            Method::PATCH,
            "/v1/food/jordan-meal",
            "edit-0",
            Some(edit(0)),
        )
        .await;
        assert_eq!(status, 404);
        let (status, body) = write(
            &base,
            Method::PATCH,
            "/v1/food/signal-meal",
            "edit-1",
            Some(edit(3)),
        )
        .await;
        assert_eq!((status, body["code"].as_str()), (409, Some("meal_changed")));

        let (status, body) = write(
            &base,
            Method::PATCH,
            "/v1/food/signal-meal",
            "edit-2",
            Some(edit(0)),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["date"], date_of(&config, 1));
        assert_eq!(body["meals"][0]["description"], "tofu curry");
        assert_eq!(body["meals"][0]["calories"], 300);
        assert_eq!(body["meals"][0]["revision"], 1);
        let facts: String = sqlx::query_scalar(
            "SELECT user_facts FROM food_signal_context WHERE food_log_id = 'signal-meal'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(facts, "paneer curry\nCorrection: the meal is tofu curry");

        // The edit bumped the revision, so the old one is now stale.
        let (status, _) = write(
            &base,
            Method::PATCH,
            "/v1/food/signal-meal",
            "edit-3",
            Some(edit(0)),
        )
        .await;
        assert_eq!(status, 409);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn deletes_only_the_callers_meal() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let at = noon_utc(&config, &date_of(&config, 1));
        insert(&pool, "keep", "alex", &at, 400).await;
        insert(&pool, "drop", "alex", &at, 300).await;
        insert(&pool, "jordan-meal", "jordan", &at, 500).await;
        let (server, base): (ApiServer, String) = serve_router(pool.clone(), config).await;

        let (status, _) = write(&base, Method::DELETE, "/v1/food/jordan-meal", "del-0", None).await;
        assert_eq!(status, 404);
        let (status, body) = write(&base, Method::DELETE, "/v1/food/drop", "del-1", None).await;
        assert_eq!(status, 200);
        let ids: Vec<&str> = body["meals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|meal| meal["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["keep"]);
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM food_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 2);
        server.shutdown().await;
    }
}
