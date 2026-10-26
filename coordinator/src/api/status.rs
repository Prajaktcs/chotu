//! `GET /v1/status`: today's activity, exercise, nutrition and goals for the
//! caller, read through the same [`crate::status`] core as Signal's `/status`.

use super::workout::{clock, member_id};
use super::{ApiError, Caller};
use crate::status::{rounded, MemberStatus, Nutrient};
use axum::extract::State;
use axum::Json;
use chotu_common::{AppConfig, FitnessOutcome, GoalProgress};
use chrono_tz::Tz;
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Arc;

/// Numbers are rounded the way Signal prints them (see `docs/app-api.md`).
#[derive(Debug, Serialize)]
pub(super) struct StatusResponse {
    /// Household-timezone day, `YYYY-MM-DD`.
    date: String,
    member: MemberBody,
    activity: ActivityBody,
    /// Synced exercise descriptions, oldest first.
    exercises: Vec<String>,
    /// `null` without fitness goals.
    fitness: Option<FitnessBody>,
    /// Empty until calories or macros are logged.
    nutrition: Vec<NutrientBody>,
    /// Configured goals only.
    goals: Vec<GoalBody>,
}

#[derive(Debug, Serialize)]
struct MemberBody {
    id: String,
    name: String,
}

#[derive(Debug, Serialize)]
struct ActivityBody {
    steps: i32,
    active_calories: i32,
    /// One decimal; `null` when not synced.
    sleep_hours: Option<f64>,
    /// 1-10; `null` when not reported.
    energy: Option<i32>,
}

#[derive(Debug, Serialize)]
struct FitnessBody {
    intent: Option<String>,
    target_date: Option<String>,
    /// Negative once the target date has passed.
    days_to_target: Option<i64>,
    focus: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct NutrientBody {
    key: &'static str,
    label: &'static str,
    /// Whole kcal for calories, otherwise one decimal.
    amount: f64,
    unit: &'static str,
    /// A breakdown of fat, shown indented under it.
    sub: bool,
}

#[derive(Debug, Serialize)]
struct GoalBody {
    key: &'static str,
    label: &'static str,
    /// `actual`, `goal` and `percent` are whole numbers.
    actual: f64,
    goal: f64,
    percent: f64,
    /// `kcal`, `g`, or empty for steps.
    unit: &'static str,
}

impl From<MemberStatus> for StatusResponse {
    fn from(status: MemberStatus) -> Self {
        let h = &status.summary;
        Self {
            date: status.date.format("%Y-%m-%d").to_string(),
            activity: ActivityBody {
                steps: h.step_count,
                active_calories: h.active_calories_burned,
                sleep_hours: h.sleep_hours.map(|hours| rounded(hours, 1)),
                energy: h.perceived_energy,
            },
            fitness: status.fitness().map(FitnessBody::from),
            nutrition: status
                .nutrients()
                .into_iter()
                .map(NutrientBody::from)
                .collect(),
            goals: status.goals().into_iter().map(GoalBody::from).collect(),
            member: MemberBody {
                id: status.member_id,
                name: status.name,
            },
            exercises: status.exercises,
        }
    }
}

impl From<FitnessOutcome> for FitnessBody {
    fn from(outcome: FitnessOutcome) -> Self {
        Self {
            intent: outcome.intent,
            target_date: outcome.target_date,
            days_to_target: outcome.days_to_target,
            focus: outcome.focus.map(|focus| focus.as_str()),
        }
    }
}

impl From<Nutrient> for NutrientBody {
    fn from(nutrient: Nutrient) -> Self {
        Self {
            key: nutrient.key,
            label: nutrient.label,
            amount: nutrient.shown_amount(),
            unit: nutrient.unit,
            sub: nutrient.sub,
        }
    }
}

impl From<GoalProgress> for GoalBody {
    fn from(goal: GoalProgress) -> Self {
        Self {
            key: goal.key,
            label: goal.label,
            actual: rounded(goal.actual, 0),
            goal: rounded(goal.goal, 0),
            percent: rounded(goal.percent(), 0),
            unit: goal.unit,
        }
    }
}

/// `GET /v1/status`: the caller's health day so far. Read-only. The coach tip
/// stays Signal-only: it needs the local model.
pub(super) async fn get_status(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
) -> Result<Json<StatusResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let (_, today) = clock(tz);
    let status = crate::status::member_status(&pool, &config, &member_id, today)
        .await
        .map_err(|error| {
            eprintln!("api_status failed: {error:?}");
            ApiError::Internal
        })?
        .ok_or(ApiError::Forbidden)?;
    Ok(Json(status.into()))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{get_json, serve_router, test_pool, ALEX_PHONE, KITCHEN_IPAD};
    use crate::status::fixtures;
    use serde_json::{json, Value};

    fn num(value: &Value) -> f64 {
        value.as_f64().unwrap()
    }

    #[tokio::test]
    async fn status_requires_a_member_and_is_empty_before_anything_is_logged() {
        let (_dir, pool) = test_pool().await;
        let (server, base) = serve_router(pool, fixtures::config()).await;
        assert_eq!(get_json(&base, "/v1/status", None, None).await.0, 401);
        assert_eq!(
            get_json(&base, "/v1/status", Some(ALEX_PHONE), None)
                .await
                .0,
            400
        );
        assert_eq!(
            get_json(&base, "/v1/status", Some(ALEX_PHONE), Some("jordan"))
                .await
                .0,
            403
        );
        let (status, body) =
            get_json(&base, "/v1/status", Some(KITCHEN_IPAD), Some("jordan")).await;
        assert_eq!(status, 200);
        assert_eq!(body["member"], json!({"id": "jordan", "name": "Jordan"}));
        assert_eq!(body["activity"]["steps"], 0);
        assert_eq!(body["activity"]["sleep_hours"], Value::Null);
        assert_eq!(body["fitness"], Value::Null);
        assert_eq!(body["nutrition"], json!([]));
        assert_eq!(body["goals"], json!([]));
        assert_eq!(body["exercises"], json!([]));
        server.shutdown().await;
    }

    /// Every number the app shows is the one Signal's `/status` prints that day.
    #[tokio::test]
    async fn status_values_match_the_signal_reply_for_the_same_day() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let today = chrono::Utc::now().date_naive();
        fixtures::seed_status(&pool, today).await;
        let (server, base) = serve_router(pool.clone(), config.clone()).await;
        let (status, body) = get_json(&base, "/v1/status", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200);
        let date = body["date"].as_str().unwrap();
        assert_eq!(date, today.format("%Y-%m-%d").to_string());

        let healths = crate::reflection::daily_health_summaries(&pool, date, &config)
            .await
            .unwrap();
        let signal = crate::status::member_statuses(&pool, &config, &healths, Some("alex"), today)
            .await
            .remove(0)
            .signal_text();

        assert!(signal.contains(&format!(
            "Health Status: {} ({date})",
            body["member"]["name"].as_str().unwrap()
        )));
        let activity = &body["activity"];
        assert!(signal.contains(&format!(
            "Burned: {} active kcal | {} steps",
            activity["active_calories"], activity["steps"]
        )));
        assert!(signal.contains(&format!(
            "Sleep: {:.1} hours",
            num(&activity["sleep_hours"])
        )));
        assert!(signal.contains(&format!("Energy Level: {}/10", activity["energy"])));
        let exercises = body["exercises"].as_array().unwrap();
        assert_eq!(exercises.len(), 2);
        for exercise in exercises {
            assert!(signal.contains(&format!("    • {}\n", exercise.as_str().unwrap())));
        }

        let fitness = &body["fitness"];
        assert!(signal.contains(&format!("Outcome: {}", fitness["intent"].as_str().unwrap())));
        let days = fitness["days_to_target"].as_i64().unwrap();
        let target = fitness["target_date"].as_str().unwrap();
        let countdown = if days > 0 {
            format!("{days} days to target ({target})")
        } else if days == 0 {
            "Target day is today".to_string()
        } else {
            format!("Target date {target} was {} days ago", -days)
        };
        assert!(signal.contains(&countdown), "{countdown:?} not in {signal}");
        assert!(signal.contains(&format!("Focus: {}", fitness["focus"].as_str().unwrap())));

        let nutrition = body["nutrition"].as_array().unwrap();
        assert_eq!(nutrition.len(), 11);
        for row in nutrition {
            let label = row["label"].as_str().unwrap();
            let label = if row["sub"] == true {
                format!("  {label}")
            } else {
                label.to_string()
            };
            let unit = row["unit"].as_str().unwrap();
            // The app prints whole kcal and one decimal otherwise.
            let shown = if row["key"] == "calories" {
                format!("{} {unit}", num(&row["amount"]))
            } else {
                format!("{:.1}{unit}", num(&row["amount"]))
            };
            let line = format!("{label:<14} | {shown:<10}\n");
            assert!(signal.contains(&line), "{line:?} not in {signal}");
        }
        // 121.25 g: Signal rounds the tie to even, so the API sends 121.2.
        let protein = nutrition
            .iter()
            .find(|row| row["key"] == "protein")
            .unwrap();
        assert_eq!(num(&protein["amount"]), 121.2);

        let goals = body["goals"].as_array().unwrap();
        assert_eq!(goals.len(), 5);
        for goal in goals {
            let line = format!(
                "{}: {}/{}{} ({}%)",
                goal["label"].as_str().unwrap(),
                num(&goal["actual"]),
                num(&goal["goal"]),
                goal["unit"].as_str().unwrap(),
                num(&goal["percent"]),
            );
            assert!(signal.contains(&line), "{line:?} not in {signal}");
        }
        server.shutdown().await;
    }

    /// A row stored under a differently cased id is the member's day, in
    /// both the app and Signal, not a zero row ahead of it.
    #[tokio::test]
    async fn status_reads_a_row_whose_id_differs_only_in_case() {
        let (_dir, pool) = test_pool().await;
        let config = fixtures::config();
        let today = chrono::Utc::now().date_naive();
        fixtures::seed_status(&pool, today).await;
        sqlx::query("UPDATE health_family_summary SET family_member_id = 'Alex'")
            .execute(&pool)
            .await
            .unwrap();
        let (server, base) = serve_router(pool.clone(), config.clone()).await;
        let (status, body) = get_json(&base, "/v1/status", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["member"], json!({"id": "alex", "name": "Alex"}));
        assert_eq!(body["activity"]["steps"], 8432);
        // Exercises are logged under the configured id, not the row's.
        assert_eq!(body["exercises"].as_array().unwrap().len(), 2, "{body}");

        let date = today.format("%Y-%m-%d").to_string();
        let healths = crate::reflection::daily_health_summaries(&pool, &date, &config)
            .await
            .unwrap();
        let signal =
            crate::status::member_statuses(&pool, &config, &healths, Some("alex"), today).await;
        assert_eq!(signal.len(), 1);
        assert_eq!(signal[0].summary.step_count, 8432);
        assert_eq!(signal[0].exercises.len(), 2);

        // Rows under both 'alex' and 'Alex': the exact id's is Alex's, and the
        // other is never reported as a second member, household-wide either.
        sqlx::query(
            "INSERT INTO health_family_summary (family_member_id, date, step_count) \
             VALUES ('alex', ?, 100)",
        )
        .bind(&date)
        .execute(&pool)
        .await
        .unwrap();
        let healths = crate::reflection::daily_health_summaries(&pool, &date, &config)
            .await
            .unwrap();
        let ids: Vec<&str> = healths
            .iter()
            .map(|h| h.family_member_id.as_str())
            .collect();
        assert_eq!(ids, ["alex", "jordan"]);
        let household = crate::status::member_statuses(&pool, &config, &healths, None, today).await;
        assert_eq!(household.len(), 2);
        assert_eq!(household[0].summary.step_count, 100);
        let (_, body) = get_json(&base, "/v1/status", Some(ALEX_PHONE), Some("alex")).await;
        assert_eq!(body["activity"]["steps"], 100);
        server.shutdown().await;
    }
}
