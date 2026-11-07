//! Wellbeing endpoints: the caller's own conditions, watchlists, 0-5 check-ins
//! and descriptive condition trends. They use the same `health_coach`
//! condition services as Signal's `/watch`, evening check-in and `/trends`,
//! and only ever read or write the chosen profile's rows: there is no
//! household view of health data (see `docs/app-api.md`).

use super::idempotency::Idempotency;
use super::workout::member_id;
use super::{ApiError, Caller};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chotu_common::AppConfig;
use chrono::{Duration, NaiveDate, Utc};
use health_coach::conditions;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/wellbeing.rs"]
pub(super) mod fixture_examples;

/// A check-in can be recorded for today or up to this many days back.
const CHECKIN_DAYS_BACK: i64 = 7;
/// Longest `/checkins` range and `/trends` window, as Signal's `/trends`.
const MAX_RANGE_DAYS: i64 = 90;
const MIN_TREND_DAYS: i64 = 7;
const DEFAULT_TREND_DAYS: i64 = 28;
const MAX_NOTE_CHARS: usize = 200;

/// `GET /v1/health/conditions` and every watchlist write.
#[derive(Debug, Serialize)]
pub(super) struct ConditionsResponse {
    conditions: Vec<ConditionBody>,
    /// The food tags a watchlist can hold.
    tags: Vec<TagBody>,
}

#[derive(Debug, Serialize)]
struct ConditionBody {
    id: String,
    label: String,
    /// The evening check-in asks for this condition's score.
    check_in: bool,
    /// Food logged this many days before a score counts, `[min, max]`.
    lag_window: [i32; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    watchlist: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TagBody {
    tag: String,
    label: String,
    description: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct RangeQuery {
    from: Option<String>,
    to: Option<String>,
}

/// `GET /v1/health/checkins` and every check-in write.
#[derive(Debug, Serialize)]
pub(super) struct CheckinsResponse {
    /// The household's today, the latest day a check-in can be for.
    today: String,
    from: String,
    to: String,
    /// Recorded scores only; a skipped day has no entry.
    checkins: Vec<CheckinBody>,
}

#[derive(Debug, Serialize)]
struct CheckinBody {
    date: String,
    condition_id: String,
    score: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// `PUT /v1/health/checkins/{date}/{condition_id}`.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct CheckinRequest {
    /// 0 = calm .. 5 = worst flare.
    score: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct TrendsQuery {
    days: Option<i64>,
}

/// `GET /v1/health/trends`: Signal's condition timelines, as data.
#[derive(Debug, Serialize)]
pub(super) struct TrendsResponse {
    from: String,
    to: String,
    days: i64,
    thresholds: ThresholdsBody,
    conditions: Vec<TrendBody>,
}

/// The minimums Signal's `/trends` applies before it describes anything.
#[derive(Debug, Serialize)]
struct ThresholdsBody {
    timeline_checkins: usize,
    comparison_pairs: usize,
    sleep_caliper_hours: f64,
}

#[derive(Debug, Serialize)]
struct TrendBody {
    id: String,
    label: String,
    lag_window: [i32; 2],
    watchlist: Vec<String>,
    checkins: usize,
    /// Every day of the window, oldest first.
    days: Vec<TrendDayBody>,
    /// Only tags with enough sleep-matched days; descriptive, never causal.
    comparisons: Vec<ComparisonBody>,
}

#[derive(Debug, Serialize)]
struct TrendDayBody {
    date: String,
    score: Option<i32>,
    sleep_hours: Option<f64>,
    /// Watchlist tags logged in the lag window before this day.
    watch_hits: Vec<String>,
    /// Food was logged on every day of the lag window.
    food_covered: bool,
}

#[derive(Debug, Serialize)]
struct ComparisonBody {
    tag: String,
    /// Mean score difference, tag days minus matched days without it.
    difference: f64,
    /// Sleep-matched pairs behind it.
    pairs: usize,
}

fn rejected(message: impl ToString) -> ApiError {
    ApiError::Rejected(StatusCode::UNPROCESSABLE_ENTITY, message.to_string())
}

fn coded(code: &'static str, message: impl ToString) -> ApiError {
    ApiError::RejectedWithCode(StatusCode::UNPROCESSABLE_ENTITY, code, message.to_string())
}

fn internal(error: anyhow::Error) -> ApiError {
    eprintln!("api_wellbeing failed: {error:?}");
    ApiError::Internal
}

fn today(config: &AppConfig) -> NaiveDate {
    Utc::now().with_timezone(&config.resolved_tz()).date_naive()
}

fn parse_date(raw: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map_err(|_| rejected("date must be YYYY-MM-DD"))
}

/// The caller's configured condition with this id, or `422 unknown_condition`.
fn condition<'a>(
    config: &'a AppConfig,
    member_id: &str,
    id: &str,
) -> Result<&'a chotu_common::HealthCondition, ApiError> {
    conditions::member_conditions(config, member_id)
        .into_iter()
        .find(|c| c.id.eq_ignore_ascii_case(id))
        .ok_or_else(|| coded("unknown_condition", "no such condition for this profile"))
}

async fn conditions_response(
    pool: &SqlitePool,
    config: &AppConfig,
    member_id: &str,
) -> Result<ConditionsResponse, ApiError> {
    let configured = conditions::member_conditions(config, member_id);
    // A profile without conditions reads no watchlist rows.
    let (watch, tags) = if configured.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        (
            conditions::watchlists(pool, member_id)
                .await
                .map_err(internal)?,
            conditions::food_tags(pool).await.map_err(internal)?,
        )
    };
    Ok(ConditionsResponse {
        conditions: configured
            .into_iter()
            .map(|c| ConditionBody {
                id: c.id.clone(),
                label: c.label.clone(),
                check_in: c.check_in,
                lag_window: c.lag_window,
                notes: c.notes.clone(),
                watchlist: watch
                    .iter()
                    .filter(|(id, _)| id == &c.id)
                    .map(|(_, tag)| tag.clone())
                    .collect(),
            })
            .collect(),
        tags: tags
            .into_iter()
            .map(|t| TagBody {
                tag: t.tag,
                label: t.label,
                description: t.description,
            })
            .collect(),
    })
}

/// `GET /v1/health/conditions`: the caller's conditions with their watchlists.
pub(super) async fn get_conditions(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
) -> Result<Json<ConditionsResponse>, ApiError> {
    let member_id = member_id(caller)?;
    Ok(Json(conditions_response(&pool, &config, &member_id).await?))
}

async fn set_watch(
    idempotency: Idempotency,
    caller: Caller,
    pool: SqlitePool,
    config: Arc<AppConfig>,
    (condition_id, tag): (String, String),
    watched: bool,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let condition = condition(&config, &member_id, &condition_id)?;
                let tags = conditions::food_tags(&pool).await.map_err(internal)?;
                let tag = tags
                    .iter()
                    .find(|t| t.tag.eq_ignore_ascii_case(&tag))
                    .ok_or_else(|| coded("unknown_tag", "no such food tag"))?;
                conditions::set_watch(&pool, &member_id, &condition.id, &tag.tag, watched)
                    .await
                    .map_err(internal)?;
                Ok(Json(conditions_response(&pool, &config, &member_id).await?))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `PUT /v1/health/conditions/{id}/watchlist/{tag}`: Signal's `/watch add`.
pub(super) async fn watch_tag(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    Path(path): Path<(String, String)>,
) -> Result<Response, ApiError> {
    set_watch(idempotency, caller, pool, config, path, true).await
}

/// `DELETE /v1/health/conditions/{id}/watchlist/{tag}`: Signal's `/watch remove`.
pub(super) async fn unwatch_tag(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    Path(path): Path<(String, String)>,
) -> Result<Response, ApiError> {
    set_watch(idempotency, caller, pool, config, path, false).await
}

async fn checkins_response(
    pool: &SqlitePool,
    config: &AppConfig,
    member_id: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<CheckinsResponse, ApiError> {
    let (from, to) = (from.to_string(), to.to_string());
    let rows = if conditions::member_conditions(config, member_id).is_empty() {
        Vec::new()
    } else {
        conditions::checkins(pool, member_id, &from, &to)
            .await
            .map_err(internal)?
    };
    Ok(CheckinsResponse {
        today: today(config).to_string(),
        from,
        to,
        checkins: rows
            .into_iter()
            .map(|row| CheckinBody {
                date: row.date,
                condition_id: row.condition_id,
                score: row.score,
                note: row.note,
            })
            .collect(),
    })
}

/// `GET /v1/health/checkins?from=&to=`: the caller's scores; by default the
/// days a check-in can still be written for (today and the 7 before).
pub(super) async fn get_checkins(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    query: Result<Query<RangeQuery>, QueryRejection>,
) -> Result<Json<CheckinsResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let Query(query) = query?;
    let to = match query.to.as_deref() {
        Some(to) => parse_date(to)?,
        None => today(&config),
    };
    let from = match query.from.as_deref() {
        Some(from) => parse_date(from)?,
        None => to - Duration::days(CHECKIN_DAYS_BACK),
    };
    if from > to || (to - from).num_days() >= MAX_RANGE_DAYS {
        return Err(rejected(format!(
            "from must be on or before to, at most {MAX_RANGE_DAYS} days"
        )));
    }
    Ok(Json(
        checkins_response(&pool, &config, &member_id, from, to).await?,
    ))
}

/// A day a check-in can be written for: the household's today or up to a week back.
fn checkin_day(config: &AppConfig, date: &str) -> Result<NaiveDate, ApiError> {
    let day = parse_date(date)?;
    let today = today(config);
    if day > today || (today - day).num_days() > CHECKIN_DAYS_BACK {
        return Err(coded(
            "date_out_of_range",
            format!("a check-in can be for today or up to {CHECKIN_DAYS_BACK} days back"),
        ));
    }
    Ok(day)
}

/// `PUT /v1/health/checkins/{date}/{condition_id}`: records or replaces that
/// day's score, like answering the evening check-in.
pub(super) async fn put_checkin(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    Path((date, condition_id)): Path<(String, String)>,
    body: Result<Json<CheckinRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    let Json(body) = body?;
    if body.score > 5 {
        return Err(rejected("score must be 0-5"));
    }
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(str::to_owned);
    if note
        .as_ref()
        .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
    {
        return Err(rejected(format!(
            "note must be at most {MAX_NOTE_CHARS} characters"
        )));
    }
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                // Inside the write: a saved check-in replays after the window moves.
                let day = checkin_day(&config, &date)?;
                let condition = condition(&config, &member_id, &condition_id)?;
                conditions::upsert_checkin(
                    &pool,
                    &member_id,
                    &day.to_string(),
                    &condition.id,
                    body.score,
                    note.as_deref(),
                )
                .await
                .map_err(internal)?;
                Ok(Json(
                    checkins_response(&pool, &config, &member_id, day, day).await?,
                ))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `DELETE /v1/health/checkins/{date}/{condition_id}`: the day reads as skipped again.
pub(super) async fn delete_checkin(
    idempotency: Idempotency,
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    Path((date, condition_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let member_id = member_id(caller)?;
    Ok(idempotency
        .run(async move {
            let result: Result<_, ApiError> = async {
                let day = checkin_day(&config, &date)?;
                let condition = condition(&config, &member_id, &condition_id)?;
                conditions::delete_checkin(&pool, &member_id, &day.to_string(), &condition.id)
                    .await
                    .map_err(internal)?;
                Ok(Json(
                    checkins_response(&pool, &config, &member_id, day, day).await?,
                ))
            }
            .await;
            result.into_response()
        })
        .await)
}

/// `GET /v1/health/trends?days=7..90`: each condition's timeline ending today,
/// with Signal's thresholds, lag windows and sleep matching.
pub(super) async fn get_trends(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    query: Result<Query<TrendsQuery>, QueryRejection>,
) -> Result<Json<TrendsResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let Query(query) = query?;
    let days = query.days.unwrap_or(DEFAULT_TREND_DAYS);
    if !(MIN_TREND_DAYS..=MAX_RANGE_DAYS).contains(&days) {
        return Err(rejected(format!(
            "days must be {MIN_TREND_DAYS}-{MAX_RANGE_DAYS}"
        )));
    }
    let to = today(&config);
    let from = to - Duration::days(days - 1);
    let trends = health_coach::condition_trends(&pool, &config, &member_id, to, days)
        .await
        .map_err(internal)?;
    Ok(Json(TrendsResponse {
        from: from.to_string(),
        to: to.to_string(),
        days,
        thresholds: ThresholdsBody {
            timeline_checkins: health_coach::condition_trends::MIN_TIMELINE_CHECKINS,
            comparison_pairs: health_coach::condition_trends::MIN_COMPARISON_PAIRS,
            sleep_caliper_hours: health_coach::condition_trends::SLEEP_CALIPER_HOURS,
        },
        conditions: trends
            .into_iter()
            .map(|trend| TrendBody {
                comparisons: trend
                    .comparisons()
                    .into_iter()
                    .map(|c| ComparisonBody {
                        tag: c.tag,
                        difference: c.difference,
                        pairs: c.pairs,
                    })
                    .collect(),
                checkins: trend.checkins(),
                id: trend.id,
                label: trend.label,
                lag_window: trend.lag,
                watchlist: trend.watch,
                days: trend
                    .days
                    .into_iter()
                    .map(|day| TrendDayBody {
                        date: day.date.to_string(),
                        score: day.score,
                        sleep_hours: day.sleep,
                        watch_hits: day.hits.into_iter().collect(),
                        food_covered: day.food_covered,
                    })
                    .collect(),
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::super::idempotency::IDEMPOTENCY_KEY;
    use super::super::tests::{
        get_json, request, serve_router, test_pool, ALEX_PHONE, KITCHEN_IPAD,
    };
    use super::*;
    use chotu_common::HealthCondition;
    use reqwest::Method;
    use serde_json::{json, Value};

    fn config() -> AppConfig {
        let mut config = crate::status::fixtures::config();
        let skin = HealthCondition {
            id: "skin".into(),
            label: "Skin symptoms".into(),
            check_in: true,
            lag_window: [0, 0],
            notes: None,
        };
        config.family.members[0].health_conditions = vec![skin.clone()];
        config.family.members[1].health_conditions = vec![HealthCondition {
            label: "Jordan private condition".into(),
            ..skin
        }];
        config
    }

    async fn send(
        base: &str,
        token: &str,
        member: &str,
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
            Some(token),
            Some(member),
        )
        .header(IDEMPOTENCY_KEY, key);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let response = builder.send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }

    fn day(config: &AppConfig, back: i64) -> String {
        (today(config) - Duration::days(back)).to_string()
    }

    #[tokio::test]
    async fn watchlists_are_the_callers_own_and_validated() {
        let (_dir, pool) = test_pool().await;
        let config = config();
        let (server, base) = serve_router(pool.clone(), config).await;
        let alex = |method, path: &'static str, key: &'static str| {
            let base = base.clone();
            async move { send(&base, ALEX_PHONE, "alex", method, path, key, None).await }
        };

        let (status, body) = get_json(
            &base,
            "/v1/health/conditions",
            Some(ALEX_PHONE),
            Some("alex"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["conditions"][0]["id"], "skin");
        assert_eq!(body["conditions"][0]["watchlist"], json!([]));
        assert!(body["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["tag"] == "dairy"));

        let (status, body) = alex(
            Method::PUT,
            "/v1/health/conditions/skin/watchlist/DAIRY",
            "w1",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["conditions"][0]["watchlist"], json!(["dairy"]));
        // A repeat is a no-op, and a replay answers the same.
        let (status, again) = alex(
            Method::PUT,
            "/v1/health/conditions/skin/watchlist/dairy",
            "w2",
        )
        .await;
        assert_eq!((status, &again["conditions"]), (200, &body["conditions"]));
        for (path, code) in [
            (
                "/v1/health/conditions/joints/watchlist/dairy",
                "unknown_condition",
            ),
            (
                "/v1/health/conditions/skin/watchlist/sprinkles",
                "unknown_tag",
            ),
        ] {
            let (status, body) =
                send(&base, ALEX_PHONE, "alex", Method::PUT, path, code, None).await;
            assert_eq!((status, body["code"].as_str()), (422, Some(code)), "{path}");
        }

        // Jordan's watchlist is separate, and Alex's phone can't act as Jordan.
        let (status, jordan) = get_json(
            &base,
            "/v1/health/conditions",
            Some(KITCHEN_IPAD),
            Some("jordan"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(jordan["conditions"][0]["label"], "Jordan private condition");
        assert_eq!(jordan["conditions"][0]["watchlist"], json!([]));
        let (status, _) = get_json(
            &base,
            "/v1/health/conditions",
            Some(ALEX_PHONE),
            Some("jordan"),
        )
        .await;
        assert_eq!(status, 403);

        let (status, body) = alex(
            Method::DELETE,
            "/v1/health/conditions/skin/watchlist/dairy",
            "w3",
        )
        .await;
        assert_eq!(
            (status, &body["conditions"][0]["watchlist"]),
            (200, &json!([]))
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn checkins_upsert_skip_and_stay_within_a_week() {
        let (_dir, pool) = test_pool().await;
        let config = config();
        let (server, base) = serve_router(pool.clone(), config.clone()).await;
        let today = day(&config, 0);
        let yesterday = day(&config, 1);
        let put = |date: String, key: &'static str, body: Value| {
            let base = base.clone();
            async move {
                let path = format!("/v1/health/checkins/{date}/skin");
                send(
                    &base,
                    ALEX_PHONE,
                    "alex",
                    Method::PUT,
                    &path,
                    key,
                    Some(body),
                )
                .await
            }
        };

        let (status, body) = put(
            yesterday.clone(),
            "c1",
            json!({"score": 3, "note": " itchy "}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            body["checkins"],
            json!([{"date": yesterday, "condition_id": "skin", "score": 3, "note": "itchy"}])
        );
        // The same day again replaces the score; zero is a real score.
        let (status, body) = put(yesterday.clone(), "c2", json!({"score": 0})).await;
        assert_eq!((status, &body["checkins"][0]["score"]), (200, &json!(0)));
        assert!(body["checkins"][0].get("note").is_none());

        for (date, key, request, code) in [
            (
                day(&config, 8),
                "old",
                json!({"score": 1}),
                Some("date_out_of_range"),
            ),
            (
                day(&config, -1),
                "future",
                json!({"score": 1}),
                Some("date_out_of_range"),
            ),
            (today.clone(), "high", json!({"score": 6}), None),
        ] {
            let (status, body) = put(date, key, request).await;
            assert_eq!(status, 422, "{key}");
            assert_eq!(body["code"].as_str(), code, "{key}");
        }
        let (status, body) = send(
            &base,
            ALEX_PHONE,
            "alex",
            Method::PUT,
            &format!("/v1/health/checkins/{today}/joints"),
            "c3",
            Some(json!({"score": 1})),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (422, Some("unknown_condition"))
        );

        let (status, _) = put(today.clone(), "c4", json!({"score": 4})).await;
        assert_eq!(status, 200);
        let (status, body) =
            get_json(&base, "/v1/health/checkins", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        assert_eq!(body["to"], today);
        let scores: Vec<_> = body["checkins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["score"].clone())
            .collect();
        assert_eq!(scores, [json!(0), json!(4)]);
        // Jordan sees none of Alex's scores.
        let (_, jordan) = get_json(
            &base,
            "/v1/health/checkins",
            Some(KITCHEN_IPAD),
            Some("jordan"),
        )
        .await;
        assert_eq!(jordan["checkins"], json!([]));

        // Removing a score leaves the day skipped, not zero.
        let path = format!("/v1/health/checkins/{yesterday}/skin");
        let (status, body) =
            send(&base, ALEX_PHONE, "alex", Method::DELETE, &path, "c5", None).await;
        assert_eq!((status, &body["checkins"]), (200, &json!([])));

        for query in [
            "?from=2026-01-10&to=2026-01-01",
            "?from=2026-01-01&to=2026-04-30",
            "?to=soon",
        ] {
            let path = format!("/v1/health/checkins{query}");
            assert_eq!(
                get_json(&base, &path, Some(ALEX_PHONE), Some("alex"))
                    .await
                    .0,
                422,
                "{query}"
            );
        }
        server.shutdown().await;
    }

    #[tokio::test]
    async fn trends_are_signals_timeline_with_skipped_days_unknown() {
        let (_dir, pool) = test_pool().await;
        let config = config();
        for back in [0, 2] {
            conditions::upsert_checkin(&pool, "alex", &day(&config, back), "skin", 2, None)
                .await
                .unwrap();
        }
        conditions::set_watch(&pool, "alex", "skin", "dairy", true)
            .await
            .unwrap();
        let (server, base) = serve_router(pool, config.clone()).await;

        let (status, body) = get_json(
            &base,
            "/v1/health/trends?days=7",
            Some(ALEX_PHONE),
            Some("alex"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["to"], day(&config, 0));
        assert_eq!(
            body["thresholds"],
            json!({"timeline_checkins": 7, "comparison_pairs": 10, "sleep_caliper_hours": 0.5})
        );
        let skin = &body["conditions"][0];
        assert_eq!(skin["checkins"], 2);
        assert_eq!(skin["watchlist"], json!(["dairy"]));
        assert_eq!(skin["comparisons"], json!([]));
        let scores: Vec<_> = skin["days"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["score"].clone())
            .collect();
        assert_eq!(
            scores,
            [
                json!(null),
                json!(null),
                json!(null),
                json!(null),
                json!(2),
                json!(null),
                json!(2)
            ]
        );
        assert_eq!(skin["days"][6]["food_covered"], false);

        for days in ["6", "91"] {
            let path = format!("/v1/health/trends?days={days}");
            assert_eq!(
                get_json(&base, &path, Some(ALEX_PHONE), Some("alex"))
                    .await
                    .0,
                422,
                "{days}"
            );
        }
        let (_, jordan) = get_json(
            &base,
            "/v1/health/trends",
            Some(KITCHEN_IPAD),
            Some("jordan"),
        )
        .await;
        assert_eq!(jordan["conditions"][0]["checkins"], 0);
        server.shutdown().await;
    }
}
