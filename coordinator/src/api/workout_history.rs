//! Read-only Fitness history and trends over `health_coach::workout_history`,
//! the same set log Signal's `/log` writes (see `docs/app-api.md`).

use super::workout::{clock, member_id, member_weight_unit};
use super::{ApiError, Caller};
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{Duration, NaiveDate};
use chrono_tz::Tz;
use health_coach::{
    ExerciseTrend, FitnessTrends, HistoryPage, HistorySet, HistoryWorkout, TrendPoint, WeekVolume,
    WeightUnit,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/workout_history.rs"]
pub(super) mod fixture_examples;

pub(super) const DEFAULT_HISTORY_DAYS: usize = 10;
pub(super) const MAX_HISTORY_DAYS: usize = 30;
pub(super) const DEFAULT_TREND_DAYS: i64 = 28;
pub(super) const MIN_TREND_DAYS: i64 = 7;
pub(super) const MAX_TREND_DAYS: i64 = 90;

#[derive(Debug, Deserialize)]
pub(super) struct HistoryQuery {
    /// `YYYY-MM-DD`: only workouts on earlier days (the previous page's `next_before`).
    before: Option<String>,
    /// Workout days per page, 1–30.
    days: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(super) struct TrendsQuery {
    /// Days ending today, 7–90.
    days: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(super) struct HistoryResponse {
    workouts: Vec<HistoryWorkoutBody>,
    next_before: Option<String>,
}

#[derive(Debug, Serialize)]
struct HistoryWorkoutBody {
    session_id: String,
    date: String,
    /// `false` while the workout is still open.
    closed: bool,
    set_count: usize,
    /// Per exercise, in first-logged order.
    exercises: Vec<HistoryExerciseBody>,
}

#[derive(Debug, Serialize)]
struct HistoryExerciseBody {
    name: String,
    /// Oldest first.
    sets: Vec<HistorySetBody>,
}

#[derive(Debug, Serialize)]
struct HistorySetBody {
    id: String,
    /// `null` is bodyweight.
    weight_lb: Option<f64>,
    weight: Option<f64>,
    unit: WeightUnit,
    reps: u32,
    /// RFC 3339, UTC.
    performed_at: String,
}

#[derive(Debug, Serialize)]
pub(super) struct TrendsResponse {
    from: String,
    to: String,
    days: i64,
    workout_days: u32,
    sets: u32,
    weeks: Vec<WeekBody>,
    exercises: Vec<ExerciseTrendBody>,
}

#[derive(Debug, Serialize)]
struct WeekBody {
    week_start: String,
    workout_days: u32,
    sets: u32,
}

#[derive(Debug, Serialize)]
struct ExerciseTrendBody {
    name: String,
    /// Oldest first; one per day the exercise was logged.
    points: Vec<TrendPointBody>,
}

#[derive(Debug, Serialize)]
struct TrendPointBody {
    date: String,
    /// The day's top load; `null` when every set was bodyweight.
    top_weight_lb: Option<f64>,
    top_weight: Option<f64>,
    unit: WeightUnit,
    /// Reps of each set at the top load.
    reps: Vec<u32>,
    sets: u32,
}

impl HistoryResponse {
    pub(super) fn new(page: HistoryPage, unit: WeightUnit) -> Self {
        Self {
            workouts: page
                .workouts
                .into_iter()
                .map(|workout| HistoryWorkoutBody::new(workout, unit))
                .collect(),
            next_before: page.next_before.map(|date| date.to_string()),
        }
    }
}

impl HistoryWorkoutBody {
    fn new(workout: HistoryWorkout, unit: WeightUnit) -> Self {
        let set_count = workout.sets.len();
        let mut exercises: Vec<HistoryExerciseBody> = Vec::new();
        for set in workout.sets {
            let key = health_coach::exercise_key(&set.exercise_name);
            let index = match exercises
                .iter()
                .position(|exercise| health_coach::exercise_key(&exercise.name) == key)
            {
                Some(index) => index,
                None => {
                    exercises.push(HistoryExerciseBody {
                        name: set.exercise_name.clone(),
                        sets: Vec::new(),
                    });
                    exercises.len() - 1
                }
            };
            exercises[index].sets.push(HistorySetBody::new(set, unit));
        }
        Self {
            session_id: workout.session_id,
            date: workout.date.to_string(),
            closed: workout.closed,
            set_count,
            exercises,
        }
    }
}

impl HistorySetBody {
    fn new(set: HistorySet, unit: WeightUnit) -> Self {
        Self {
            id: set.id,
            weight_lb: set.weight_lb,
            weight: set.weight_lb.map(|weight| unit.from_lb(weight)),
            unit,
            reps: set.reps,
            performed_at: set.performed_at.and_utc().to_rfc3339(),
        }
    }
}

impl TrendsResponse {
    pub(super) fn new(trends: FitnessTrends, unit: WeightUnit) -> Self {
        Self {
            from: trends.from.to_string(),
            to: trends.to.to_string(),
            days: (trends.to - trends.from).num_days() + 1,
            workout_days: trends.workout_days,
            sets: trends.sets,
            weeks: trends.weeks.into_iter().map(WeekBody::from).collect(),
            exercises: trends
                .exercises
                .into_iter()
                .map(|exercise| ExerciseTrendBody::new(exercise, unit))
                .collect(),
        }
    }
}

impl From<WeekVolume> for WeekBody {
    fn from(week: WeekVolume) -> Self {
        Self {
            week_start: week.week_start.to_string(),
            workout_days: week.workout_days,
            sets: week.sets,
        }
    }
}

impl ExerciseTrendBody {
    fn new(exercise: ExerciseTrend, unit: WeightUnit) -> Self {
        Self {
            name: exercise.name,
            points: exercise
                .points
                .into_iter()
                .map(|point| TrendPointBody::new(point, unit))
                .collect(),
        }
    }
}

impl TrendPointBody {
    fn new(point: TrendPoint, unit: WeightUnit) -> Self {
        Self {
            date: point.date.to_string(),
            top_weight_lb: point.top_weight_lb,
            top_weight: point.top_weight_lb.map(|weight| unit.from_lb(weight)),
            unit,
            reps: point.reps,
            sets: point.sets,
        }
    }
}

fn unprocessable(message: &str) -> ApiError {
    ApiError::Rejected(StatusCode::UNPROCESSABLE_ENTITY, message.to_string())
}

fn internal(err: anyhow::Error) -> ApiError {
    eprintln!("api_workout_history failed: {err:?}");
    ApiError::Internal
}

/// `GET /v1/workout/history`: the caller's past workouts, newest first.
pub(super) async fn get_history(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<chotu_common::AppConfig>>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<HistoryResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let Query(query) = query?;
    let days = query.days.unwrap_or(DEFAULT_HISTORY_DAYS);
    if !(1..=MAX_HISTORY_DAYS).contains(&days) {
        return Err(unprocessable("days must be 1-30"));
    }
    let before = query
        .before
        .as_deref()
        .map(|raw| NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d"))
        .transpose()
        .map_err(|_| unprocessable("before must be YYYY-MM-DD"))?;
    let page = health_coach::workout_history(&pool, &member_id, before, days)
        .await
        .map_err(internal)?;
    let unit = member_weight_unit(&config, &member_id);
    Ok(Json(HistoryResponse::new(page, unit)))
}

/// `GET /v1/workout/trends`: the caller's training over the last `days` days.
pub(super) async fn get_trends(
    caller: Caller,
    State(pool): State<SqlitePool>,
    State(config): State<Arc<chotu_common::AppConfig>>,
    State(tz): State<Tz>,
    query: Result<Query<TrendsQuery>, QueryRejection>,
) -> Result<Json<TrendsResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let Query(query) = query?;
    let days = query.days.unwrap_or(DEFAULT_TREND_DAYS);
    if !(MIN_TREND_DAYS..=MAX_TREND_DAYS).contains(&days) {
        return Err(unprocessable("days must be 7-90"));
    }
    let (_, today) = clock(tz);
    let from = today - Duration::days(days - 1);
    let trends = health_coach::fitness_trends(&pool, &member_id, from, today)
        .await
        .map_err(internal)?;
    let unit = member_weight_unit(&config, &member_id);
    Ok(Json(TrendsResponse::new(trends, unit)))
}
