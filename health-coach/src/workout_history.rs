//! Read-only views over logged workouts: past sessions and per-exercise trends.
//! Both read the same `fitness_set_log` rows that `/log` and the app write, so
//! every client sees the same history. Weights stay in lb; callers convert.

use crate::fitness_plan::week_start_monday;
use crate::strength_log::{exercise_key, session_expired, working_sets, SetRecord};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use sqlx::SqlitePool;
use std::collections::HashMap;

/// One stored set, with the time it was performed.
#[derive(Debug, Clone, PartialEq)]
pub struct HistorySet {
    pub id: String,
    pub exercise_name: String,
    /// `None` is bodyweight.
    pub weight_lb: Option<f64>,
    pub reps: u32,
    /// UTC; the client's `performed_at` for app sets, the log time for Signal sets.
    pub performed_at: NaiveDateTime,
}

/// One workout session that has at least one set.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryWorkout {
    pub session_id: String,
    /// Household-timezone day.
    pub date: NaiveDate,
    /// `false` while the workout is still open: not closed, and not yet
    /// expired by the day change or idle rule.
    pub closed: bool,
    /// Oldest first.
    pub sets: Vec<HistorySet>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryPage {
    /// Newest day first; within a day, newest session first.
    pub workouts: Vec<HistoryWorkout>,
    /// Pass as `before` for the next page; `None` on the last page.
    pub next_before: Option<NaiveDate>,
}

/// Workouts on the `days` most recent workout days before `before` (all days
/// when `None`). Paging by day keeps a day's sessions together. `now` and
/// `today` (household) apply the expiry rule, so a workout left without Done
/// isn't shown as in progress.
pub async fn workout_history(
    pool: &SqlitePool,
    member_id: &str,
    before: Option<NaiveDate>,
    days: usize,
    now: DateTime<Utc>,
    today: NaiveDate,
) -> Result<HistoryPage> {
    let before = before.map_or_else(|| "9999-12-31".to_string(), |d| d.to_string());
    let dates: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT date FROM fitness_set_log \
         WHERE family_member_id = ? AND date < ? ORDER BY date DESC LIMIT ?",
    )
    .bind(member_id)
    .bind(&before)
    .bind(days as i64 + 1)
    .fetch_all(pool)
    .await
    .context("Failed to load workout days")?;
    let more = dates.len() > days;
    let dates: Vec<String> = dates.into_iter().take(days).map(|(d,)| d).collect();
    let (Some(newest), Some(oldest)) = (dates.first(), dates.last()) else {
        return Ok(HistoryPage {
            workouts: Vec::new(),
            next_before: None,
        });
    };
    let next_before = if more {
        Some(parse_date(oldest)?)
    } else {
        None
    };

    let sessions: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, date, closed_at, last_activity_at FROM fitness_workout_sessions \
         WHERE family_member_id = ? AND date >= ? AND date <= ? \
         ORDER BY date DESC, started_at DESC, id DESC",
    )
    .bind(member_id)
    .bind(oldest)
    .bind(newest)
    .fetch_all(pool)
    .await
    .context("Failed to load workout sessions")?;
    let rows: Vec<(String, String, String, Option<f64>, i64, String)> = sqlx::query_as(
        "SELECT id, session_id, exercise_name, weight_lb, reps, created_at FROM fitness_set_log \
         WHERE family_member_id = ? AND date >= ? AND date <= ? \
         ORDER BY created_at ASC, rowid ASC",
    )
    .bind(member_id)
    .bind(oldest)
    .bind(newest)
    .fetch_all(pool)
    .await
    .context("Failed to load workout sets")?;

    let mut sets: HashMap<String, Vec<HistorySet>> = HashMap::new();
    for (id, session_id, exercise_name, weight_lb, reps, created_at) in rows {
        sets.entry(session_id).or_default().push(HistorySet {
            id,
            exercise_name,
            weight_lb,
            reps: reps as u32,
            performed_at: NaiveDateTime::parse_from_str(&created_at, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("Bad set time {created_at}"))?,
        });
    }
    let workouts = sessions
        .into_iter()
        .filter_map(|(id, date, closed_at, last_activity_at)| {
            let sets = sets.remove(&id)?;
            let closed =
                closed_at.is_some() || session_expired(&date, &last_activity_at, now, today);
            Some((id, date, closed, sets))
        })
        .map(|(session_id, date, closed, sets)| {
            Ok(HistoryWorkout {
                session_id,
                date: parse_date(&date)?,
                closed,
                sets,
            })
        })
        .collect::<Result<_>>()?;
    Ok(HistoryPage {
        workouts,
        next_before,
    })
}

/// One day's working sets for an exercise: the top load and the reps done at it,
/// the same reading `next_target` uses for progression.
#[derive(Debug, Clone, PartialEq)]
pub struct TrendPoint {
    pub date: NaiveDate,
    /// `None` when every set was bodyweight.
    pub top_weight_lb: Option<f64>,
    /// Reps of each set at the top load, in order.
    pub reps: Vec<u32>,
    /// All sets of this exercise that day.
    pub sets: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExerciseTrend {
    /// The most recently logged spelling.
    pub name: String,
    /// Oldest first.
    pub points: Vec<TrendPoint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeekVolume {
    pub week_start: NaiveDate,
    /// Days with logged sets or a synced strength session.
    pub workout_days: u32,
    /// Logged sets.
    pub sets: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitnessTrends {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub workout_days: u32,
    pub sets: u32,
    /// Every Monday-start week touching the range, oldest first.
    pub weeks: Vec<WeekVolume>,
    /// Most-trained first, then by name.
    pub exercises: Vec<ExerciseTrend>,
}

/// Training over `[from, to]`: workout days and sets per week, and each
/// exercise's working sets per day.
pub async fn fitness_trends(
    pool: &SqlitePool,
    member_id: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<FitnessTrends> {
    let (start, end) = (from.to_string(), to.to_string());
    let days = crate::strength_log::lifting_dates(pool, member_id, &start, &end).await?;
    let rows: Vec<(String, String, String, Option<f64>, i64)> = sqlx::query_as(
        "SELECT date, exercise_key, exercise_name, weight_lb, reps FROM fitness_set_log \
         WHERE family_member_id = ? AND date >= ? AND date <= ? \
         ORDER BY date ASC, created_at ASC, rowid ASC",
    )
    .bind(member_id)
    .bind(&start)
    .bind(&end)
    .fetch_all(pool)
    .await
    .context("Failed to load sets for trends")?;

    let mut weeks: Vec<WeekVolume> = Vec::new();
    let mut monday = week_start_monday(from);
    while monday <= to {
        weeks.push(WeekVolume {
            week_start: monday,
            workout_days: 0,
            sets: 0,
        });
        monday += Duration::days(7);
    }
    let week_of = |date: NaiveDate| {
        let index = (week_start_monday(date) - week_start_monday(from)).num_days() / 7;
        usize::try_from(index).ok()
    };
    for day in &days {
        if let Some(week) = week_of(parse_date(day)?).and_then(|i| weeks.get_mut(i)) {
            week.workout_days += 1;
        }
    }

    // Per exercise key: (latest name, per-day sets in date order).
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, (String, Vec<(NaiveDate, Vec<SetRecord>)>)> = HashMap::new();
    for (date, key, name, weight_lb, reps) in &rows {
        let date = parse_date(date)?;
        if let Some(week) = week_of(date).and_then(|i| weeks.get_mut(i)) {
            week.sets += 1;
        }
        let key = if key.is_empty() {
            exercise_key(name)
        } else {
            key.clone()
        };
        let entry = by_key.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            (name.clone(), Vec::new())
        });
        entry.0 = name.clone();
        match entry.1.last_mut() {
            Some((day, sets)) if *day == date => sets.push((*weight_lb, *reps as u32)),
            _ => entry.1.push((date, vec![(*weight_lb, *reps as u32)])),
        }
    }
    let mut exercises: Vec<ExerciseTrend> = order
        .into_iter()
        .filter_map(|key| by_key.remove(&key))
        .map(|(name, days)| ExerciseTrend {
            name,
            points: days
                .into_iter()
                .map(|(date, sets)| {
                    let (top_weight_lb, reps) = working_sets(&sets);
                    TrendPoint {
                        date,
                        top_weight_lb,
                        reps,
                        sets: sets.len() as u32,
                    }
                })
                .collect(),
        })
        .collect();
    exercises.sort_by(|a, b| {
        b.points
            .len()
            .cmp(&a.points.len())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(FitnessTrends {
        from,
        to,
        workout_days: days.len() as u32,
        sets: rows.len() as u32,
        weeks,
        exercises,
    })
}

fn parse_date(raw: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").with_context(|| format!("Bad workout date {raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        chotu_common::init_db(":memory:").await.unwrap()
    }

    async fn session(pool: &SqlitePool, id: &str, member: &str, date: &str, closed: bool) {
        sqlx::query(
            "INSERT INTO fitness_workout_sessions \
             (id, family_member_id, date, started_at, last_activity_at, closed_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(member)
        .bind(date)
        .bind(format!("{date}T09:00:00Z"))
        .bind(format!("{date}T09:30:00Z"))
        .bind(closed.then(|| format!("{date}T10:00:00Z")))
        .execute(pool)
        .await
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    async fn set(
        pool: &SqlitePool,
        id: &str,
        session: &str,
        member: &str,
        date: &str,
        name: &str,
        weight: Option<f64>,
        reps: i64,
        time: &str,
    ) {
        sqlx::query(
            "INSERT INTO fitness_set_log \
             (id, session_id, family_member_id, date, exercise_key, exercise_name, weight_lb, \
              reps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(session)
        .bind(member)
        .bind(date)
        .bind(exercise_key(name))
        .bind(name)
        .bind(weight)
        .bind(reps)
        .bind(format!("{date} {time}"))
        .execute(pool)
        .await
        .unwrap();
    }

    fn d(raw: &str) -> NaiveDate {
        parse_date(raw).unwrap()
    }

    /// Shortly after the fixture sessions' last activity (09:30Z).
    fn now() -> DateTime<Utc> {
        "2026-10-24T10:00:00Z".parse().unwrap()
    }

    #[tokio::test]
    async fn an_open_workout_from_an_earlier_day_or_left_idle_reads_as_closed() {
        let pool = pool().await;
        let today = d("2026-10-24");
        let read = |at: &'static str| {
            let pool = pool.clone();
            async move {
                workout_history(&pool, "alex", None, 5, at.parse().unwrap(), today)
                    .await
                    .unwrap()
                    .workouts[0]
                    .closed
            }
        };
        // Left open yesterday: the next workout operation would close it.
        session(&pool, "old", "alex", "2026-10-23", false).await;
        set(
            &pool,
            "o1",
            "old",
            "alex",
            "2026-10-23",
            "Squat",
            Some(95.0),
            5,
            "09:10:00",
        )
        .await;
        assert!(read("2026-10-24T10:00:00Z").await);
        let open: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM fitness_workout_sessions WHERE closed_at IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 1, "reading never closes a workout");

        sqlx::query("DELETE FROM fitness_set_log")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM fitness_workout_sessions")
            .execute(&pool)
            .await
            .unwrap();
        session(&pool, "live", "alex", "2026-10-24", false).await;
        set(
            &pool,
            "l1",
            "live",
            "alex",
            "2026-10-24",
            "Squat",
            Some(95.0),
            5,
            "09:10:00",
        )
        .await;
        assert!(!read("2026-10-24T10:00:00Z").await);
        // Idle past the rule (last activity 09:30Z).
        assert!(read("2026-10-24T13:00:00Z").await);
    }

    #[tokio::test]
    async fn history_pages_by_day_and_stays_with_the_member() {
        let pool = pool().await;
        for (i, date) in ["2026-10-20", "2026-10-22", "2026-10-24"]
            .iter()
            .enumerate()
        {
            session(&pool, &format!("s{i}"), "alex", date, true).await;
            set(
                &pool,
                &format!("a{i}"),
                &format!("s{i}"),
                "alex",
                date,
                "Bench press",
                Some(135.0),
                8,
                "09:10:00",
            )
            .await;
            set(
                &pool,
                &format!("b{i}"),
                &format!("s{i}"),
                "alex",
                date,
                "Bench press",
                Some(135.0),
                7,
                "09:12:00",
            )
            .await;
        }
        // An empty session and another member's workout never appear.
        session(&pool, "empty", "alex", "2026-10-23", true).await;
        session(&pool, "j", "jordan", "2026-10-25", false).await;
        set(
            &pool,
            "j1",
            "j",
            "jordan",
            "2026-10-25",
            "Squat",
            Some(95.0),
            5,
            "08:00:00",
        )
        .await;

        let first = workout_history(&pool, "alex", None, 2, now(), d("2026-10-24"))
            .await
            .unwrap();
        let ids: Vec<_> = first
            .workouts
            .iter()
            .map(|w| w.session_id.as_str())
            .collect();
        assert_eq!(ids, ["s2", "s1"]);
        assert_eq!(first.next_before, Some(d("2026-10-22")));
        assert_eq!(first.workouts[0].sets.len(), 2);
        assert_eq!(first.workouts[0].sets[0].reps, 8);
        assert!(first.workouts[0].closed);

        let second = workout_history(&pool, "alex", first.next_before, 2, now(), d("2026-10-24"))
            .await
            .unwrap();
        let ids: Vec<_> = second
            .workouts
            .iter()
            .map(|w| w.session_id.as_str())
            .collect();
        assert_eq!(ids, ["s0"]);
        assert_eq!(second.next_before, None);

        let none = workout_history(&pool, "sam", None, 5, now(), d("2026-10-24"))
            .await
            .unwrap();
        assert!(none.workouts.is_empty());
        assert_eq!(none.next_before, None);
    }

    #[tokio::test]
    async fn trends_read_working_sets_per_day_and_weekly_volume() {
        let pool = pool().await;
        session(&pool, "s1", "alex", "2026-10-19", true).await;
        // A warm-up below the top load is not a working set.
        set(
            &pool,
            "w",
            "s1",
            "alex",
            "2026-10-19",
            "Bench press",
            Some(95.0),
            10,
            "09:00:00",
        )
        .await;
        set(
            &pool,
            "a",
            "s1",
            "alex",
            "2026-10-19",
            "Bench press",
            Some(135.0),
            8,
            "09:05:00",
        )
        .await;
        set(
            &pool,
            "b",
            "s1",
            "alex",
            "2026-10-19",
            "Bench press",
            Some(135.0),
            7,
            "09:08:00",
        )
        .await;
        set(
            &pool,
            "p",
            "s1",
            "alex",
            "2026-10-19",
            "Push-up",
            None,
            12,
            "09:20:00",
        )
        .await;
        session(&pool, "s2", "alex", "2026-10-27", false).await;
        set(
            &pool,
            "c",
            "s2",
            "alex",
            "2026-10-27",
            "bench press",
            Some(140.0),
            8,
            "09:05:00",
        )
        .await;

        let trends = fitness_trends(&pool, "alex", d("2026-10-19"), d("2026-10-28"))
            .await
            .unwrap();
        assert_eq!(trends.workout_days, 2);
        assert_eq!(trends.sets, 5);
        assert_eq!(
            trends.weeks,
            vec![
                WeekVolume {
                    week_start: d("2026-10-19"),
                    workout_days: 1,
                    sets: 4
                },
                WeekVolume {
                    week_start: d("2026-10-26"),
                    workout_days: 1,
                    sets: 1
                },
            ]
        );
        assert_eq!(trends.exercises[0].name, "bench press");
        assert_eq!(
            trends.exercises[0].points,
            vec![
                TrendPoint {
                    date: d("2026-10-19"),
                    top_weight_lb: Some(135.0),
                    reps: vec![8, 7],
                    sets: 3
                },
                TrendPoint {
                    date: d("2026-10-27"),
                    top_weight_lb: Some(140.0),
                    reps: vec![8],
                    sets: 1
                },
            ]
        );
        assert_eq!(trends.exercises[1].name, "Push-up");
        assert_eq!(trends.exercises[1].points[0].top_weight_lb, None);
        assert_eq!(trends.exercises[1].points[0].reps, vec![12]);

        let empty = fitness_trends(&pool, "jordan", d("2026-10-19"), d("2026-10-28"))
            .await
            .unwrap();
        assert_eq!(empty.workout_days, 0);
        assert!(empty.exercises.is_empty());
        assert_eq!(empty.weeks.len(), 2);
    }
}
