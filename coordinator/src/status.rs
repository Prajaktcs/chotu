//! Today's health status for `/status` and `GET /v1/status`.

#[cfg(test)]
pub(crate) mod fixtures {
    //! A member's day and week, shared by the Signal snapshot tests and the
    //! API tests that check both clients show the same numbers.

    use chotu_common::{AppConfig, FitnessFocus, FitnessGoals, NutritionGoals};
    use chrono::{Duration, NaiveDate, TimeZone, Utc};
    use health_coach::{
        Load, PerformedAt, PlanDay, PlanDayKind, PlanExercise, SetInput, StoredWeeklyPlan,
        WeeklyFitnessPlan,
    };
    use sqlx::SqlitePool;

    /// Monday of the fixture week.
    pub(crate) fn week_start() -> NaiveDate {
        NaiveDate::from_ymd_opt(2025, 3, 10).unwrap()
    }

    /// Wednesday of the fixture week: a strength day with history.
    pub(crate) fn day() -> NaiveDate {
        week_start() + Duration::days(2)
    }

    pub(crate) async fn pool() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = chotu_common::init_db(dir.path().join("status.sqlite").to_str().unwrap())
            .await
            .unwrap();
        (dir, pool)
    }

    /// Alex has goals; Jordan has none and logs nothing.
    pub(crate) fn config() -> AppConfig {
        let mut config = AppConfig::default();
        let mut jordan = config.family.members[0].clone();
        jordan.id = "jordan".into();
        jordan.name = "Jordan".into();
        let alex = &mut config.family.members[0];
        alex.signal_aci = Some("aci-alex".into());
        alex.nutrition_goals = Some(NutritionGoals {
            calories: Some(2200),
            protein_g: Some(150.0),
            carbs_g: None,
            fats_g: Some(70.0),
            fiber_g: Some(30.0),
            steps: Some(10_000),
        });
        alex.fitness_goals = Some(FitnessGoals {
            intent: Some("Run a 10k".into()),
            target_date: Some("2025-06-01".into()),
            focus: Some(FitnessFocus::Endurance),
            sessions_per_week: Some(4),
            session_minutes: Some(45),
            equipment: None,
            constraints: vec![],
            weekly_targets: None,
        });
        config.family.members.push(jordan);
        config
    }

    /// Alex's summary and synced exercises on `day`.
    pub(crate) async fn seed_status(pool: &SqlitePool, day: NaiveDate) {
        let date = day.format("%Y-%m-%d").to_string();
        sqlx::query(
            "INSERT INTO health_family_summary (family_member_id, date, total_calories_ingested, \
             protein_grams, carbs_grams, fats_grams, step_count, active_calories_burned, \
             sleep_hours, perceived_energy, saturated_fat_g, cholesterol_mg, vitamin_c_mg, \
             sodium_mg, fiber_g, sugar_g, caffeine_mg) \
             VALUES ('alex', ?, 1840, 121.25, 190.4, 61.0, 8432, 415, 7.25, 7, 18.5, 210.0, \
             64.75, 2100.0, 24.0, 41.3, 95.0)",
        )
        .bind(&date)
        .execute(pool)
        .await
        .unwrap();
        for (i, (description, kind, minutes)) in [
            ("Running (32 min, 310 kcal)", "Running", 32),
            ("Walking (20 min)", "Walking", 20),
        ]
        .into_iter()
        .enumerate()
        {
            sqlx::query(
                "INSERT INTO exercise_log (id, date, family_member_id, description, \
                 activity_type, duration_minutes, created_at) \
                 VALUES (?, ?, 'alex', ?, ?, ?, ?)",
            )
            .bind(format!("ex-{date}-{i}"))
            .bind(&date)
            .bind(description)
            .bind(kind)
            .bind(minutes)
            .bind(format!("{date} 0{i}:00:00"))
            .execute(pool)
            .await
            .unwrap();
        }
    }

    fn lift(name: &str, sets: u32, reps: &str) -> PlanExercise {
        PlanExercise {
            name: name.into(),
            sets,
            reps: reps.into(),
        }
    }

    fn day_plan(weekday: &str, kind: PlanDayKind, notes: &str, ex: Vec<PlanExercise>) -> PlanDay {
        PlanDay {
            weekday: weekday.into(),
            kind,
            notes: notes.into(),
            exercises: ex,
        }
    }

    pub(crate) fn plan() -> WeeklyFitnessPlan {
        use PlanDayKind::*;
        WeeklyFitnessPlan {
            theme: "Build the base".into(),
            days: vec![
                day_plan(
                    "Monday",
                    Strength,
                    "lower body",
                    vec![
                        lift("Leg press", 3, "10-12"),
                        lift("Bench press", 3, "8-10"),
                    ],
                ),
                day_plan(
                    "Tuesday",
                    Cardio,
                    "easy pace",
                    vec![lift("Easy run", 1, "30 min easy")],
                ),
                day_plan(
                    "Wednesday",
                    Strength,
                    "full body, RPE 7",
                    vec![
                        lift("Leg press", 3, "10-12"),
                        lift("Lat pulldown", 3, "8-12"),
                        lift("Plank", 3, "45s"),
                    ],
                ),
                day_plan("Thursday", Rest, "", vec![]),
                day_plan(
                    "Friday",
                    Mixed,
                    "",
                    vec![lift("Goblet squat", 3, "12"), lift("Bike", 1, "15 min")],
                ),
                day_plan(
                    "Saturday",
                    Cardio,
                    "long run",
                    vec![lift("Run", 1, "45 min")],
                ),
                day_plan("Sunday", Rest, "", vec![]),
            ],
        }
    }

    /// Alex's plan for the fixture week, Monday's lifts, and Tuesday's run.
    pub(crate) async fn seed_plan(pool: &SqlitePool) -> StoredWeeklyPlan {
        let monday = week_start();
        let week = monday.format("%Y-%m-%d").to_string();
        let stored = health_coach::save_weekly_plan(pool, "alex", &week, &plan())
            .await
            .unwrap();
        let at = Utc.from_utc_datetime(&monday.and_hms_opt(17, 0, 0).unwrap());
        for (exercise, weight, reps) in [("Leg press", 180.0, 12), ("Bench press", 135.0, 8)] {
            health_coach::log_sets(
                pool,
                "alex",
                at,
                monday,
                PerformedAt::new(at),
                Some(exercise),
                &[SetInput {
                    load: Load::Weight(weight),
                    reps,
                    count: 3,
                }],
            )
            .await
            .unwrap();
        }
        health_coach::close_workout(pool, "alex", at, monday)
            .await
            .unwrap();
        let tuesday = (monday + Duration::days(1)).format("%Y-%m-%d").to_string();
        sqlx::query(
            "INSERT INTO exercise_log (id, date, family_member_id, description, \
             activity_type, duration_minutes) \
             VALUES ('run-tuesday', ?, 'alex', 'Running (30 min)', 'Running', 30)",
        )
        .bind(tuesday)
        .execute(pool)
        .await
        .unwrap();
        stored
    }
}
