//! `GET /v1/plan`: this week's training plan, today's session with targets,
//! and progress, read through the same `health_coach::plan_week` core as
//! Signal's `/plan`.

use super::media::{self, ExerciseMedia};
use super::workout::{
    clock, member_id, member_weight_unit, planned_exercises, PlanDayBody, PlannedExerciseBody,
};
use super::{ApiError, Caller};
use axum::extract::State;
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

/// `GET /v1/plan`: this week's plan. Read-only: it never generates one
/// (Signal's `/plan` does, with the local model).
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
    let response = |plan, reason| PlanResponse {
        date: today.format("%Y-%m-%d").to_string(),
        week_start: monday.format("%Y-%m-%d").to_string(),
        plan,
        reason,
    };
    if !crate::status::has_fitness_goals(&config, &member_id) {
        return Ok(Json(response(None, Some("no_fitness_goals"))));
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
    let Some(week) = week else {
        return Ok(Json(response(None, Some("not_generated"))));
    };
    let Some(plan) = PlanBody::new(week, monday, today, unit, &config) else {
        // Signal's `/plan` still shows the stored text; the app can't lay it
        // out, so it says so (and `/plan` in Signal) rather than failing.
        eprintln!("api_plan: stored plan for {member_id} does not parse");
        return Ok(Json(response(None, Some("unreadable"))));
    };
    Ok(Json(response(Some(plan), None)))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{get_json, serve_router, test_pool, ALEX_PHONE, KITCHEN_IPAD};
    use crate::status::fixtures;
    use health_coach::WeightUnit;
    use serde_json::{json, Value};

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
