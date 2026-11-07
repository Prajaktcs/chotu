//! Food endpoints: list a day's meals, add one (described or photographed),
//! edit one, delete one. Inserts, revisions and deletions go through the same
//! `health_coach` operations as Signal's `/food`, food photos, meal-reply
//! corrections and undo (see `docs/app-api.md`).

use super::idempotency::Idempotency;
use super::workout::member_id;
use super::{ApiError, Caller};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chotu_common::{AppConfig, FoodLog, FoodPhotoKind, GeminiClient, NutritionEstimation};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/food.rs"]
pub(super) mod fixture_examples;

/// Longer than any real meal description; keeps prompts and rows bounded.
const MAX_DESCRIPTION_CHARS: usize = 500;

/// A phone photo after the app's JPEG compression is well under this.
const MAX_PHOTO_BYTES: usize = 8 * 1024 * 1024;

/// `POST /v1/food` body limit: a base64 photo at [`MAX_PHOTO_BYTES`] plus the JSON around it.
pub(super) const MAX_ADD_BODY_BYTES: usize = MAX_PHOTO_BYTES / 3 * 4 + 64 * 1024;

/// Image types Gemini vision accepts.
const PHOTO_TYPES: [&str; 5] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
];

/// The `code` on a `409` when the meal was revised since the app loaded it.
const MEAL_CHANGED_CODE: &str = "meal_changed";

/// The `code` on a `422` when a barcode photo is sent to update a meal.
const BARCODE_UPDATE_CODE: &str = "barcode_update";

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
    /// What was eaten. With a photo it is an optional caption (portion, what
    /// the photo leaves out), and the logged description comes from the photo.
    #[serde(default)]
    description: String,
    /// `YYYY-MM-DD`; today or earlier.
    date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    photo: Option<MealPhoto>,
}

/// A plate, package or barcode photo to estimate the meal from. It is not stored.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct MealPhoto {
    /// One of [`PHOTO_TYPES`].
    content_type: String,
    /// The image bytes, standard base64.
    data: String,
}

struct Photo {
    content_type: String,
    bytes: Vec<u8>,
}

/// `PATCH /v1/food/{id}`: the replacement description, re-estimated.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct EditMealRequest {
    description: String,
    revision: i64,
}

/// `POST /v1/food/{id}/correct`: Signal's meal-reply correction or photo
/// update. Unaffected ingredients, portions and exclusions carry over.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct CorrectMealRequest {
    revision: i64,
    /// What changed ("paneer, not eggs; half the bowl"). Required without a
    /// photo; with one it is an optional caption.
    #[serde(default)]
    correction: String,
    /// A plate or package photo that fills in details. A barcode can't update a meal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    photo: Option<MealPhoto>,
}

/// The answer to a correction: the updated day, or a question and nothing written.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum CorrectMealResponse {
    Updated {
        day: FoodDayResponse,
        /// Only for a member linked to Google Health.
        #[serde(skip_serializing_if = "Option::is_none")]
        remote: Option<RemoteSync>,
    },
    Clarify {
        question: String,
    },
}

/// Google Health after a local revision: replaced, or left for `/sync`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteSync {
    Synced,
    Pending,
}

/// `POST /v1/food/clear`: Signal's `/clearfood` for today.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct ClearDayRequest {
    /// Must be today (household): Signal clears only today.
    date: String,
}

/// `POST /v1/food/adjust`: Signal's `/adjustfood` for today.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct AdjustDayRequest {
    date: String,
    calories: i32,
    protein_g: f64,
    carbs_g: f64,
    fat_g: f64,
}

#[derive(Debug, Deserialize)]
pub(super) struct TrendsQuery {
    days: Option<i64>,
}

/// `GET /v1/food/trends`: daily nutrition summaries and the member's targets.
#[derive(Debug, Serialize)]
pub(super) struct FoodTrendsResponse {
    from: String,
    to: String,
    days: i64,
    /// Configured in `config.yaml`; every field is `null` when unset.
    goals: GoalsBody,
    /// Days with a nutrition summary, oldest first. Missing days have none.
    summaries: Vec<DaySummaryBody>,
}

#[derive(Debug, Serialize)]
struct GoalsBody {
    calories: Option<i32>,
    protein_g: Option<f64>,
    carbs_g: Option<f64>,
    fat_g: Option<f64>,
    fiber_g: Option<f64>,
}

#[derive(Debug, Serialize)]
struct DaySummaryBody {
    date: String,
    calories: i32,
    protein_g: f64,
    carbs_g: f64,
    fat_g: f64,
    fiber_g: f64,
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
    let text = caption(raw)?;
    if text.is_empty() {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("description must be 1-{MAX_DESCRIPTION_CHARS} characters"),
        ));
    }
    Ok(text)
}

/// A photo's caption, which may be empty.
fn caption(raw: &str) -> Result<&str, ApiError> {
    let text = raw.trim();
    if text.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("description must be at most {MAX_DESCRIPTION_CHARS} characters"),
        ));
    }
    Ok(text)
}

fn decode_photo(photo: &MealPhoto) -> Result<Photo, ApiError> {
    let content_type = photo.content_type.trim().to_ascii_lowercase();
    if !PHOTO_TYPES.contains(&content_type.as_str()) {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("photo must be one of {}", PHOTO_TYPES.join(", ")),
        ));
    }
    let bytes = STANDARD.decode(photo.data.trim()).map_err(|_| {
        rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            "photo data must be base64",
        )
    })?;
    if bytes.is_empty() || bytes.len() > MAX_PHOTO_BYTES {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "photo must be 1 byte to {} MB",
                MAX_PHOTO_BYTES / 1024 / 1024
            ),
        ));
    }
    Ok(Photo {
        content_type,
        bytes,
    })
}

/// Nothing is written before this, so a failure is a retryable 5xx.
async fn estimate(gemini: &GeminiClient, text: &str) -> Result<NutritionEstimation, ApiError> {
    gemini.approximate_nutrition(text).await.map_err(|error| {
        eprintln!("api_food nutrition estimate failed: {error:?}");
        rejected(StatusCode::BAD_GATEWAY, "nutrition estimate failed")
    })
}

/// The meal a photo shows, like Signal's food photos: a barcode is looked up
/// in Open Food Facts, anything else is the vision estimate. Returns the
/// logged description and its nutrition. Nothing is written before this.
///
/// For an update, `vision_caption` carries the meal's current facts, and a
/// barcode or an empty description is refused as in Signal.
async fn estimate_photo(
    gemini: &GeminiClient,
    photo: &Photo,
    caption: &str,
    update_of: Option<&str>,
) -> Result<(String, NutritionEstimation), ApiError> {
    let vision_caption = update_of.unwrap_or(caption);
    let (analysis, source) = gemini
        .approximate_nutrition_from_image_with_fallback(
            &photo.bytes,
            &photo.content_type,
            vision_caption,
        )
        .await
        .map_err(|error| {
            eprintln!("api_food photo analysis failed: {error:?}");
            rejected(StatusCode::BAD_GATEWAY, "photo analysis failed")
        })?;
    if analysis.kind == FoodPhotoKind::Unknown {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            "That photo doesn't look like food. Try a plate, package or barcode.",
        ));
    }
    if update_of.is_some() {
        if analysis.kind == FoodPhotoKind::Barcode || analysis.barcode.is_some() {
            return Err(ApiError::RejectedWithCode(
                StatusCode::UNPROCESSABLE_ENTITY,
                BARCODE_UPDATE_CODE,
                "A barcode is one product, not the whole meal. Describe the change instead.".into(),
            ));
        }
        if analysis.description.trim().is_empty() {
            return Err(rejected(
                StatusCode::UNPROCESSABLE_ENTITY,
                "The photo didn't describe the meal. Try again or describe the change.",
            ));
        }
    }
    let meal = chotu_common::photo_meal(analysis, source, caption).await;
    Ok((meal.description, meal.nutrition))
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

/// `POST /v1/food`: estimate a described or photographed meal and log it on `date`.
pub(super) async fn add_meal(
    idempotency: Idempotency,
    caller: Caller,
    State(state): State<super::ApiState>,
    body: Result<Json<AddMealRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    let photo = body.photo.as_ref().map(decode_photo).transpose()?;
    let text = match photo {
        Some(_) => caption(&body.description)?,
        None => description(&body.description)?,
    }
    .to_string();
    let date = past_or_today(&state.config, &body.date)?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let config = &state.config;
                let (meal, est, tag_text) = match &photo {
                    Some(photo) => {
                        let (meal, est) = estimate_photo(&state.gemini, photo, &text, None).await?;
                        let tag_text = format!("{meal}\n{text}");
                        (meal, est, tag_text)
                    }
                    None => (
                        text.clone(),
                        estimate(&state.gemini, &text).await?,
                        text.clone(),
                    ),
                };
                // Today without a meal word is "now"; an earlier day is its noon.
                let timing = chotu_common::resolve_food_log_timing_tz(
                    Some(&date.format("%Y-%m-%d").to_string()),
                    chotu_common::effective_food_time(&text, None).as_deref(),
                    config.resolved_tz(),
                );
                let log_id = uuid::Uuid::new_v4().to_string();
                let assigned = chotu_common::assign_food_tags(&est.tags, &tag_text);
                health_coach::insert_food_log(
                    &state.pool,
                    &log_id,
                    timing.timestamp,
                    &member_id,
                    &meal,
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

fn meal_changed() -> ApiError {
    ApiError::RejectedWithCode(
        StatusCode::CONFLICT,
        MEAL_CHANGED_CODE,
        "meal changed since it was loaded".into(),
    )
}

/// The caller's meal at `revision`, or `409 meal_changed`.
async fn meal_at(
    pool: &SqlitePool,
    member_id: &str,
    id: &str,
    revision: i64,
) -> Result<FoodLog, ApiError> {
    let log = owned_meal(pool, member_id, id).await?;
    let current = health_coach::food_log_revision(pool, id)
        .await
        .map_err(internal)?;
    if current != revision {
        return Err(meal_changed());
    }
    Ok(log)
}

/// The Signal conversation a meal was logged in, with its user facts.
struct SignalFacts {
    recipient_kind: String,
    recipient_id: String,
    sender_aci: String,
    user_facts: String,
}

async fn signal_facts(pool: &SqlitePool, id: &str) -> Result<Option<SignalFacts>, ApiError> {
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT recipient_kind, recipient_id, sender_aci, user_facts \
         FROM food_signal_context WHERE food_log_id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| internal(error.into()))?;
    Ok(row.map(
        |(recipient_kind, recipient_id, sender_aci, user_facts)| SignalFacts {
            recipient_kind,
            recipient_id,
            sender_aci,
            user_facts,
        },
    ))
}

/// Commits the revision locally, then replaces it in Google Health when linked.
/// Signal meals keep their conversation facts current, so a later reply
/// correction builds on this one.
async fn save_revision(
    pool: &SqlitePool,
    config: &AppConfig,
    log: &FoodLog,
    revision: i64,
    signal: Option<&SignalFacts>,
    update: &health_coach::meal_updates::MealRevision,
) -> Result<Option<RemoteSync>, ApiError> {
    let context = signal.map(|signal| chotu_common::FoodSignalContext {
        recipient_kind: &signal.recipient_kind,
        recipient_id: &signal.recipient_id,
        sender_aci: &signal.sender_aci,
        user_facts: &update.facts,
    });
    health_coach::revise_food_log(
        pool,
        config,
        log,
        revision,
        &update.description,
        &update.nutrition,
        &update.tag_context,
        context.as_ref(),
    )
    .await
    .map_err(|error| {
        // The revision CAS lost to a concurrent change or deletion.
        if error.to_string().contains("stale") {
            meal_changed()
        } else {
            internal(error)
        }
    })?;
    if !health_coach::member_health_credentials_configured(&log.family_member_id, config) {
        return Ok(None);
    }
    Ok(Some(
        match health_coach::sync_corrected_food_log(pool, config, &log.id).await {
            Ok(()) => RemoteSync::Synced,
            Err(error) => {
                eprintln!(
                    "api_food: corrected meal sync pending for {}: {error:?}",
                    log.id
                );
                RemoteSync::Pending
            }
        },
    ))
}

/// `PATCH /v1/food/{id}`: replace a meal's description and re-estimate it,
/// keeping its time.
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
                let log = meal_at(&state.pool, &member_id, &id, body.revision).await?;
                let est = estimate(&state.gemini, &text).await?;
                let signal = signal_facts(&state.pool, &id).await?;
                let facts = signal
                    .as_ref()
                    .map(|signal| format!("{}\nCorrection: the meal is {text}", signal.user_facts))
                    .unwrap_or_default();
                let update = health_coach::meal_updates::MealRevision {
                    description: text.clone(),
                    nutrition: est,
                    facts,
                    tag_context: text.clone(),
                };
                save_revision(
                    &state.pool,
                    config,
                    &log,
                    body.revision,
                    signal.as_ref(),
                    &update,
                )
                .await?;
                let date = civil_date(config, &log);
                Ok(Json(day(&state.pool, config, &member_id, date).await?))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `POST /v1/food/{id}/correct`: Signal's meal correction. A text correction
/// changes only what it names; a photo fills in details without overriding
/// stated facts. An ambiguous correction returns a question and writes nothing.
pub(super) async fn correct_meal(
    idempotency: Idempotency,
    caller: Caller,
    State(state): State<super::ApiState>,
    Path(id): Path<String>,
    body: Result<Json<CorrectMealRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    let photo = body.photo.as_ref().map(decode_photo).transpose()?;
    let text = match photo {
        Some(_) => caption(&body.correction)?,
        None => description(&body.correction)?,
    }
    .to_string();
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let config = &state.config;
                let log = meal_at(&state.pool, &member_id, &id, body.revision).await?;
                let signal = signal_facts(&state.pool, &id).await?;
                let facts = signal
                    .as_ref()
                    .map(|signal| signal.user_facts.as_str())
                    .unwrap_or_default();
                let update = match &photo {
                    Some(photo) => {
                        let vision = health_coach::meal_updates::photo_update_caption(
                            &log.raw_text_description,
                            facts,
                            &text,
                        );
                        let (meal, est) =
                            estimate_photo(&state.gemini, photo, &text, Some(&vision)).await?;
                        health_coach::meal_updates::photo_update(facts, &text, meal, est)
                    }
                    None => {
                        let input = health_coach::meal_updates::correction_input(
                            &log.raw_text_description,
                            facts,
                        );
                        let analysis = state
                            .gemini
                            .correct_food_estimation(&input, &text)
                            .await
                            .map_err(|error| {
                                eprintln!("api_food correction estimate failed: {error:?}");
                                rejected(StatusCode::BAD_GATEWAY, "correction estimate failed")
                            })?;
                        match health_coach::meal_updates::text_correction(facts, &text, analysis) {
                            Ok(update) => update,
                            Err(question) => {
                                return Ok(Json(CorrectMealResponse::Clarify { question }));
                            }
                        }
                    }
                };
                let remote = save_revision(
                    &state.pool,
                    config,
                    &log,
                    body.revision,
                    signal.as_ref(),
                    &update,
                )
                .await?;
                let date = civil_date(config, &log);
                Ok(Json(CorrectMealResponse::Updated {
                    day: day(&state.pool, config, &member_id, date).await?,
                    remote,
                }))
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

fn parse_day(date: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|error| internal(error.into()))
}

/// Signal's clear and adjust work on today only.
fn only_today(config: &AppConfig, raw: &str) -> Result<String, ApiError> {
    let day = past_or_today(config, raw)?;
    if day != today(config) {
        return Err(ApiError::RejectedWithCode(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not_today",
            "only today's meals can be cleared or adjusted".into(),
        ));
    }
    Ok(day.format("%Y-%m-%d").to_string())
}

fn day_error(error: health_coach::FoodDayError) -> ApiError {
    eprintln!("api_food day write failed: {error:?}");
    let (code, message) = match error {
        health_coach::FoodDayError::Select(_) => ("not_changed", "nothing was changed; retry"),
        health_coach::FoodDayError::DeletionPending(_) => (
            "deletion_pending",
            "meal deletion is still pending; retry to finish it",
        ),
        health_coach::FoodDayError::AdjustmentFailed(_) => (
            "adjustment_failed",
            "the meals were removed, but the new totals were not saved",
        ),
    };
    ApiError::RejectedWithCode(StatusCode::BAD_GATEWAY, code, message.into())
}

/// `POST /v1/food/clear`: removes today's meals, keeping synced nutrition and activity.
pub(super) async fn clear_day(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    body: Result<Json<ClearDayRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                // Inside the write: a saved clear replays after midnight
                // instead of failing the today check.
                let date = only_today(&config, &body.date)?;
                health_coach::clear_food_day(&pool, &config, &member_id, &date)
                    .await
                    .map_err(day_error)?;
                Ok(Json(
                    day(&pool, &config, &member_id, parse_day(&date)?).await?,
                ))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `POST /v1/food/adjust`: replaces today's meals with one audited total.
pub(super) async fn adjust_day(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    body: Result<Json<AdjustDayRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    let valid = |grams: f64| grams.is_finite() && (0.0..=2000.0).contains(&grams);
    if !(0..=20_000).contains(&body.calories)
        || !valid(body.protein_g)
        || !valid(body.carbs_g)
        || !valid(body.fat_g)
    {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            "calories must be 0-20000 and grams 0-2000",
        ));
    }
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let date = only_today(&config, &body.date)?;
                health_coach::replace_food_day_totals(
                    &pool,
                    &config,
                    &member_id,
                    &date,
                    body.calories,
                    body.protein_g,
                    body.carbs_g,
                    body.fat_g,
                )
                .await
                .map_err(day_error)?;
                Ok(Json(
                    day(&pool, &config, &member_id, parse_day(&date)?).await?,
                ))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `GET /v1/food/trends?days=7..90`: the summaries Signal's `/trends` reads.
pub(super) async fn get_trends(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    query: Result<Query<TrendsQuery>, QueryRejection>,
) -> Result<Json<FoodTrendsResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let Query(query) = query?;
    let days = query.days.unwrap_or(28);
    if !(7..=90).contains(&days) {
        return Err(rejected(
            StatusCode::UNPROCESSABLE_ENTITY,
            "days must be 7-90",
        ));
    }
    let (from, to, summaries) = health_coach::nutrition_history(&pool, &config, &member_id, days)
        .await
        .map_err(internal)?;
    let goals = config
        .family
        .members
        .iter()
        .find(|member| member.id == member_id)
        .and_then(|member| member.nutrition_goals.as_ref());
    Ok(Json(FoodTrendsResponse {
        from,
        to,
        days,
        goals: GoalsBody {
            calories: goals.and_then(|g| g.calories),
            protein_g: goals.and_then(|g| g.protein_g),
            carbs_g: goals.and_then(|g| g.carbs_g),
            fat_g: goals.and_then(|g| g.fats_g),
            fiber_g: goals.and_then(|g| g.fiber_g),
        },
        summaries: summaries
            .into_iter()
            .map(|day| DaySummaryBody {
                date: day.date,
                calories: day.calories,
                protein_g: day.protein_g,
                carbs_g: day.carbs_g,
                fat_g: day.fats_g,
                fiber_g: day.fiber_g,
            })
            .collect(),
    }))
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

    /// Base64 photo data the Gemini stand-in reads as not food.
    const NOT_FOOD: &str = "bm90IGZvb2Q=";
    /// Base64 photo data the Gemini stand-in reads as a barcode.
    const BARCODE: &str = "YmFyY29kZQ==";
    /// A correction the Gemini stand-in can't place, so it asks.
    const AMBIGUOUS: &str = "the paneer one";

    /// A Gemini stand-in: every estimate is 300 kcal. A photo whose data is
    /// [`NOT_FOOD`] is not food; any other photo is a plated "Paneer tikka plate".
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
        let answer = move |request: &str| {
            let part = if request.contains("inlineData") {
                let (kind, barcode) = if request.contains(NOT_FOOD) {
                    ("UNKNOWN", None)
                } else if request.contains(BARCODE) {
                    ("BARCODE", Some("0000000000000"))
                } else {
                    ("PLATED", None)
                };
                let analysis = json!({
                    "kind": kind, "barcode": barcode,
                    "description": "Paneer tikka plate", "nutrition": nutrition,
                });
                json!({"text": analysis.to_string()})
            } else if request.contains("correcting one existing meal") {
                let clarification = request
                    .contains(AMBIGUOUS)
                    .then_some("Which part is paneer?");
                let analysis = json!({
                    "description": "Paneer curry, half bowl", "nutrition": nutrition,
                    "clarification": clarification,
                });
                json!({"functionCall": {"name": "submit", "args": analysis}})
            } else {
                json!({"functionCall": {"name": "submit", "args": nutrition}})
            };
            json!({
                "responseId": "test",
                "candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP"}]
            })
            .to_string()
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let answer = answer.clone();
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
                    let body = answer(&String::from_utf8_lossy(&request));
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
    async fn adds_a_meal_from_a_photo_and_rejects_non_food() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let llm = chotu_common::ChotuLlm::new("http://127.0.0.1", 0, "unused");
        let (server, base) =
            serve_router_with_clients(pool.clone(), config.clone(), llm, gemini().await).await;
        let today = date_of(&config, 0);
        let photo = |data: &str| json!({"content_type": "image/jpeg", "data": data});

        for (key, request) in [
            (
                "bad-type",
                json!({"date": today, "photo": {"content_type": "image/gif", "data": "R0lG"}}),
            ),
            (
                "bad-data",
                json!({"date": today, "photo": photo("not base64!")}),
            ),
            ("not-food", json!({"date": today, "photo": photo(NOT_FOOD)})),
        ] {
            let (status, _) = write(&base, Method::POST, "/v1/food", key, Some(request)).await;
            assert_eq!(status, 422, "{key}");
        }

        // A caption is optional; the logged description comes from the photo.
        let (status, body) = write(
            &base,
            Method::POST,
            "/v1/food",
            "photo-1",
            Some(json!({"description": "", "date": today, "photo": photo("cGFuZWVy")})),
        )
        .await;
        assert_eq!(status, 201);
        let meals = body["meals"].as_array().unwrap();
        assert_eq!(meals.len(), 1);
        assert_eq!(meals[0]["description"], "Paneer tikka plate");
        assert_eq!(meals[0]["calories"], 300);

        // A phone photo is larger than axum's default 2 MB JSON limit.
        let big = STANDARD.encode(vec![0u8; 3 * 1024 * 1024]);
        let (status, _) = write(
            &base,
            Method::POST,
            "/v1/food",
            "photo-big",
            Some(json!({"description": "lunch", "date": today, "photo": photo(&big)})),
        )
        .await;
        assert_eq!(status, 201);
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
    async fn corrections_keep_the_meal_ask_when_ambiguous_and_refuse_barcodes() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let yesterday = date_of(&config, 1);
        let at = noon_utc(&config, &yesterday);
        insert(&pool, "signal-meal", "alex", &at, 500).await;
        insert(&pool, "jordan-meal", "jordan", &at, 500).await;
        chotu_common::write_food_signal_context(
            &pool,
            "signal-meal",
            &chotu_common::FoodSignalContext {
                recipient_kind: "direct",
                recipient_id: "aci-alex",
                sender_aci: "aci-alex",
                user_facts: "no dairy",
            },
        )
        .await
        .unwrap();
        let llm = chotu_common::ChotuLlm::new("http://127.0.0.1", 0, "unused");
        let (server, base) =
            serve_router_with_clients(pool.clone(), config.clone(), llm, gemini().await).await;
        let correct = |key: &'static str, body: Value| {
            let base = base.clone();
            async move {
                let path = "/v1/food/signal-meal/correct";
                write(&base, Method::POST, path, key, Some(body)).await
            }
        };
        let photo = |data: &str| json!({"content_type": "image/jpeg", "data": data});

        // Validation, ownership and the revision all come before any estimate.
        let (status, _) = correct("blank", json!({"revision": 0, "correction": " "})).await;
        assert_eq!(status, 422);
        let (status, _) = write(
            &base,
            Method::POST,
            "/v1/food/jordan-meal/correct",
            "theirs",
            Some(json!({"revision": 0, "correction": "half"})),
        )
        .await;
        assert_eq!(status, 404);
        let (status, body) = correct("stale", json!({"revision": 4, "correction": "half"})).await;
        assert_eq!((status, body["code"].as_str()), (409, Some("meal_changed")));

        // A question writes nothing.
        let (status, body) = correct("ask", json!({"revision": 0, "correction": AMBIGUOUS})).await;
        assert_eq!(status, 200);
        assert_eq!(
            body,
            json!({"status": "clarify", "question": "Which part is paneer?"})
        );
        assert_eq!(
            health_coach::food_log_revision(&pool, "signal-meal")
                .await
                .unwrap(),
            0
        );

        // A barcode can't stand in for a whole meal.
        let (status, body) = correct(
            "barcode",
            json!({"revision": 0, "correction": "", "photo": photo(BARCODE)}),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (422, Some("barcode_update"))
        );

        // Corrected in place: same id and time, one meal, facts appended.
        let request = json!({"revision": 0, "correction": "paneer, not eggs; half the bowl"});
        let (status, body) = correct("fix", request.clone()).await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "updated");
        assert!(body.get("remote").is_none(), "alex has no Google Health");
        let meals = body["day"]["meals"].as_array().unwrap();
        let ids: Vec<&str> = meals.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["signal-meal"]);
        assert_eq!(meals[0]["description"], "Paneer curry, half bowl");
        assert_eq!(meals[0]["revision"], 1);
        assert_eq!(
            meals[0]["eaten_at"]
                .as_str()
                .unwrap()
                .parse::<DateTime<Utc>>()
                .unwrap()
                .to_rfc3339(),
            at
        );
        let facts: String = sqlx::query_scalar(
            "SELECT user_facts FROM food_signal_context WHERE food_log_id = 'signal-meal'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            facts,
            "no dairy\nCorrection: paneer, not eggs; half the bowl"
        );
        // A lost answer replays instead of correcting twice.
        assert_eq!(correct("fix", request).await, (200, body));

        // A photo update keeps the meal too.
        let (status, body) = correct(
            "photo",
            json!({"revision": 1, "correction": "the rest of it", "photo": photo("cGFuZWVy")}),
        )
        .await;
        assert_eq!(status, 200);
        let meals = body["day"]["meals"].as_array().unwrap();
        assert_eq!(meals.len(), 1);
        assert_eq!(meals[0]["description"], "Paneer tikka plate");
        assert_eq!(meals[0]["revision"], 2);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM food_log WHERE family_member_id = 'alex'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
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

    #[tokio::test]
    async fn clears_and_adjusts_only_today_and_reports_trends_with_goals() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let today = date_of(&config, 0);
        let yesterday = date_of(&config, 1);
        insert(&pool, "breakfast", "alex", &noon_utc(&config, &today), 400).await;
        insert(&pool, "lunch", "alex", &noon_utc(&config, &today), 600).await;
        insert(&pool, "old", "alex", &noon_utc(&config, &yesterday), 500).await;
        insert(&pool, "jordans", "jordan", &noon_utc(&config, &today), 700).await;
        sqlx::query(
            "INSERT INTO health_family_summary (date, family_member_id, total_calories_ingested, \
             protein_grams, carbs_grams, fats_grams, fiber_g) VALUES (?, 'alex', 1800, 120, 200, 60, 25)",
        )
        .bind(&yesterday)
        .execute(&pool)
        .await
        .unwrap();
        let (server, base) = serve_router(pool.clone(), config.clone()).await;

        let (status, body) = write(
            &base,
            Method::POST,
            "/v1/food/clear",
            "clear-old",
            Some(json!({"date": yesterday})),
        )
        .await;
        assert_eq!((status, body["code"].as_str()), (422, Some("not_today")));

        let (status, cleared) = write(
            &base,
            Method::POST,
            "/v1/food/clear",
            "clear-1",
            Some(json!({"date": today})),
        )
        .await;
        assert_eq!(status, 200, "{cleared}");
        assert_eq!(cleared["meals"], json!([]));
        // Yesterday's meal and Jordan's stay.
        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM food_log ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(left, ["jordans", "old"]);
        // A replay is the same answer, with nothing removed twice.
        assert_eq!(
            write(
                &base,
                Method::POST,
                "/v1/food/clear",
                "clear-1",
                Some(json!({"date": today}))
            )
            .await
            .1,
            cleared
        );

        insert(&pool, "snack", "alex", &noon_utc(&config, &today), 300).await;
        let adjust =
            json!({"date": today, "calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 60});
        let (status, adjusted) = write(
            &base,
            Method::POST,
            "/v1/food/adjust",
            "adjust-1",
            Some(adjust),
        )
        .await;
        assert_eq!(status, 200, "{adjusted}");
        let meals = adjusted["meals"].as_array().unwrap();
        assert_eq!(meals.len(), 1, "{adjusted}");
        assert!(meals[0]["description"]
            .as_str()
            .unwrap()
            .starts_with("Manual adjustment"));
        let bad = json!({"date": today, "calories": -1, "protein_g": 0, "carbs_g": 0, "fat_g": 0});
        assert_eq!(
            write(
                &base,
                Method::POST,
                "/v1/food/adjust",
                "adjust-bad",
                Some(bad)
            )
            .await
            .0,
            422
        );

        let (status, trends) = get_json(
            &base,
            "/v1/food/trends?days=7",
            Some(ALEX_PHONE),
            Some("alex"),
        )
        .await;
        assert_eq!(status, 200, "{trends}");
        assert_eq!(trends["days"], 7);
        assert_eq!(trends["to"], today);
        let summary = trends["summaries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|day| day["date"] == yesterday)
            .unwrap();
        assert_eq!(summary["calories"], 1800);
        assert_eq!(summary["fiber_g"], 25.0);
        assert!(trends["goals"].is_object());
        assert_eq!(
            get_json(
                &base,
                "/v1/food/trends?days=3",
                Some(ALEX_PHONE),
                Some("alex")
            )
            .await
            .0,
            422
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_retried_clear_resumes_its_recorded_meals_and_keeps_newer_ones() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let today = date_of(&config, 0);
        let at = noon_utc(&config, &today);
        insert(&pool, "selected", "alex", &at, 400).await;
        // The first attempt recorded its selection, then remote cleanup failed.
        sqlx::query(
            "INSERT INTO food_log_deletion_intents (food_log_id, family_member_id, civil_date, original_timestamp, revision) \
             VALUES ('selected', 'alex', ?, ?, 0)",
        )
        .bind(&today)
        .bind(&at)
        .execute(&pool)
        .await
        .unwrap();
        // Logged in Signal before the retry.
        insert(&pool, "newer", "alex", &at, 300).await;
        let (server, base) = serve_router(pool.clone(), config.clone()).await;
        let (status, body) = write(
            &base,
            Method::POST,
            "/v1/food/clear",
            "clear-retry",
            Some(json!({"date": today})),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM food_log")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(left, ["newer"]);
        server.shutdown().await;
    }
}
