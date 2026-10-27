//! Today's health status for `/status` and `GET /v1/status`, and the
//! fitness-goal check `/plan` and `GET /v1/plan` share.
//!
//! [`member_statuses`] reads one member's day as data; Signal renders it with
//! [`MemberStatus::signal_text`] and the app API serves it as JSON, so both
//! show the same numbers for the same day.

use anyhow::Result;
use chotu_common::{
    AppConfig, FitnessGoals, FitnessOutcome, GoalProgress, HealthFamilySummary, NutritionGoals,
};
use chrono::NaiveDate;
use sqlx::SqlitePool;

/// Signal lists at most this many of the day's exercises.
const SIGNAL_EXERCISES: usize = 6;

/// One member's health day.
#[derive(Debug, Clone)]
pub(crate) struct MemberStatus {
    pub date: NaiveDate,
    pub member_id: String,
    /// Display name; the member id when the member is not configured.
    pub name: String,
    pub summary: HealthFamilySummary,
    /// Synced exercise descriptions, oldest first.
    pub exercises: Vec<String>,
    pub nutrition_goals: Option<NutritionGoals>,
    /// Only when at least one fitness goal is set.
    pub fitness_goals: Option<FitnessGoals>,
}

/// One row of the nutrition table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Nutrient {
    /// Stable id, e.g. `protein`, `saturated_fat`, `vitamin_c`.
    pub key: &'static str,
    pub label: &'static str,
    pub amount: f64,
    /// `kcal`, `g`, `mg` or `mcg`.
    pub unit: &'static str,
    /// A breakdown of fat (saturated, cholesterol, ...), indented under Fat.
    pub sub: bool,
}

impl Nutrient {
    /// The amount as Signal shows it: whole kcal, otherwise one decimal.
    pub fn shown(&self) -> String {
        if self.key == "calories" {
            format!("{} kcal", self.amount as i32)
        } else {
            format!("{:.1}{}", self.amount, self.unit)
        }
    }

    /// The number in [`Nutrient::shown`].
    pub fn shown_amount(&self) -> f64 {
        if self.key == "calories" {
            self.amount
        } else {
            rounded(self.amount, 1)
        }
    }
}

/// `value` rounded the way Rust's `{:.N}` formatting shows it (ties to even),
/// so a client printing the result with N decimals shows Signal's digits.
pub(crate) fn rounded(value: f64, decimals: usize) -> f64 {
    format!("{value:.decimals$}").parse().unwrap_or(value)
}

impl MemberStatus {
    pub fn has_activity(&self) -> bool {
        self.summary.step_count > 0 || self.summary.active_calories_burned > 0
    }

    pub fn has_nutrition(&self) -> bool {
        let h = &self.summary;
        h.total_calories_ingested > 0
            || h.protein_grams > 0.0
            || h.carbs_grams > 0.0
            || h.fats_grams > 0.0
    }

    /// Anything logged or configured for the day (the coach may still find more).
    pub fn has_any_data(&self) -> bool {
        self.has_activity()
            || self.summary.sleep_hours.is_some()
            || self.summary.perceived_energy.is_some()
            || self.has_nutrition()
            || !self.exercises.is_empty()
            || self.fitness_goals.is_some()
    }

    /// The nutrition table: calories and macros, then each other nutrient
    /// above zero. Empty when no calories or macros were logged.
    pub fn nutrients(&self) -> Vec<Nutrient> {
        if !self.has_nutrition() {
            return Vec::new();
        }
        let h = &self.summary;
        let row = |key, label, amount, unit, sub| Nutrient {
            key,
            label,
            amount,
            unit,
            sub,
        };
        let mut rows = vec![
            row(
                "calories",
                "Calories",
                h.total_calories_ingested as f64,
                "kcal",
                false,
            ),
            row("protein", "Protein", h.protein_grams, "g", false),
            row("carbs", "Carbs", h.carbs_grams, "g", false),
            row("fat", "Fat", h.fats_grams, "g", false),
        ];
        let optional = [
            row("saturated_fat", "Saturated", h.saturated_fat_g, "g", true),
            row(
                "unsaturated_fat",
                "Unsaturated",
                h.unsaturated_fat_g,
                "g",
                true,
            ),
            row("trans_fat", "Trans Fat", h.trans_fat_g, "g", true),
            row("cholesterol", "Cholesterol", h.cholesterol_mg, "mg", true),
            row(
                "triglycerides",
                "Triglycerides",
                h.triglycerides_mg,
                "mg",
                true,
            ),
            row("omega_3_dha", "Omega-3 DHA", h.omega_3_dha_mg, "mg", true),
            row("vitamin_a", "Vitamin A", h.vitamin_a_mcg, "mcg", false),
            row("vitamin_b", "Vitamin B", h.vitamin_b_mg, "mg", false),
            row("vitamin_c", "Vitamin C", h.vitamin_c_mg, "mg", false),
            row("vitamin_d", "Vitamin D", h.vitamin_d_mcg, "mcg", false),
            row("vitamin_e", "Vitamin E", h.vitamin_e_mg, "mg", false),
            row("vitamin_k", "Vitamin K", h.vitamin_k_mcg, "mcg", false),
            row("sodium", "Sodium", h.sodium_mg, "mg", false),
            row("potassium", "Potassium", h.potassium_mg, "mg", false),
            row("calcium", "Calcium", h.calcium_mg, "mg", false),
            row("magnesium", "Magnesium", h.magnesium_mg, "mg", false),
            row("zinc", "Zinc", h.zinc_mg, "mg", false),
            row("iron", "Iron", h.iron_mg, "mg", false),
            row("fiber", "Fiber", h.fiber_g, "g", false),
            row("sugar", "Sugar", h.sugar_g, "g", false),
            row("caffeine", "Caffeine", h.caffeine_mg, "mg", false),
        ];
        rows.extend(optional.into_iter().filter(|n| n.amount > 0.0));
        rows
    }

    /// Each configured nutrition/steps goal against today's values.
    pub fn goals(&self) -> Vec<GoalProgress> {
        let h = &self.summary;
        self.nutrition_goals
            .as_ref()
            .map(|goals| {
                goals.progress(
                    h.total_calories_ingested,
                    h.protein_grams,
                    h.carbs_grams,
                    h.fats_grams,
                    h.fiber_g,
                    h.step_count,
                )
            })
            .unwrap_or_default()
    }

    pub fn fitness(&self) -> Option<FitnessOutcome> {
        self.fitness_goals.as_ref()?.outcome(self.date)
    }

    /// The `/status` health report before the coach's tip.
    pub fn signal_text(&self) -> String {
        let h = &self.summary;
        let mut report = format!(
            "🏃 *Health Status: {} ({})*\n\n",
            self.name,
            self.date.format("%Y-%m-%d")
        );

        if self.has_activity()
            || h.sleep_hours.is_some()
            || h.perceived_energy.is_some()
            || !self.exercises.is_empty()
        {
            report.push_str("• *Activity & Wellness*:\n");
            if self.has_activity() {
                report.push_str(&format!(
                    "  - Burned: {} active kcal | {} steps\n",
                    h.active_calories_burned, h.step_count
                ));
            }
            if let Some(sleep) = h.sleep_hours {
                report.push_str(&format!("  - Sleep: {:.1} hours\n", sleep));
            }
            if let Some(energy) = h.perceived_energy {
                report.push_str(&format!("  - Energy Level: {}/10\n", energy));
            }
            if !self.exercises.is_empty() {
                report.push_str("  - Exercises:\n");
                for e in self.exercises.iter().take(SIGNAL_EXERCISES) {
                    report.push_str(&format!("    • {}\n", e));
                }
            }
            report.push('\n');
        }

        if let Some(block) = self
            .fitness_goals
            .as_ref()
            .and_then(|fitness| fitness.outcome_markdown(self.date))
        {
            report.push_str(&block);
            report.push('\n');
        }

        let nutrients = self.nutrients();
        if !nutrients.is_empty() {
            report.push_str("• *Nutrition Summary*:\n");
            report.push_str("```\n");
            report.push_str("Nutrient       | Amount    \n");
            report.push_str("---------------+-----------\n");
            for nutrient in nutrients {
                let indent = if nutrient.sub { "  " } else { "" };
                report.push_str(&format!(
                    "{:<14} | {:<10}\n",
                    format!("{indent}{}", nutrient.label),
                    nutrient.shown()
                ));
            }
            report.push_str("```\n");
        }

        if let Some(progress) = self.nutrition_goals.as_ref().and_then(|goals| {
            goals.progress_markdown(
                h.total_calories_ingested,
                h.protein_grams,
                h.carbs_grams,
                h.fats_grams,
                h.fiber_g,
                h.step_count,
            )
        }) {
            report.push('\n');
            report.push_str(&progress);
        }
        report
    }
}

/// A status per summary in `healths` (only `only`'s when set), in order.
/// Exercises that cannot be read are left out, as `/status` always has.
pub(crate) async fn member_statuses(
    pool: &SqlitePool,
    config: &AppConfig,
    healths: &[HealthFamilySummary],
    only: Option<&str>,
    date: NaiveDate,
) -> Vec<MemberStatus> {
    let date_str = date.format("%Y-%m-%d").to_string();
    let mut statuses = Vec::new();
    for h in healths {
        if only.is_some_and(|only| !h.family_member_id.eq_ignore_ascii_case(only)) {
            continue;
        }
        let member = config
            .family
            .members
            .iter()
            .find(|m| m.id.eq_ignore_ascii_case(&h.family_member_id));
        // The configured id, which the rest of the day (exercises, goals) is
        // logged under, even when the summary row's id differs in case.
        let member_id = member.map_or(h.family_member_id.as_str(), |m| m.id.as_str());
        let exercises = health_coach::exercises_for_day(pool, member_id, &date_str)
            .await
            .unwrap_or_default();
        statuses.push(MemberStatus {
            date,
            member_id: member_id.to_string(),
            name: member
                .map(|m| m.name.clone())
                .unwrap_or_else(|| h.family_member_id.clone()),
            summary: h.clone(),
            exercises,
            nutrition_goals: member.and_then(|m| m.nutrition_goals.clone()),
            fitness_goals: member
                .and_then(|m| m.fitness_goals.clone())
                .filter(|goals| !goals.is_empty()),
        });
    }
    statuses
}

/// Whether `member_id` has any `fitness_goals`; a weekly plan needs them.
pub(crate) fn has_fitness_goals(config: &AppConfig, member_id: &str) -> bool {
    config
        .family
        .members
        .iter()
        .find(|m| m.id.eq_ignore_ascii_case(member_id))
        .and_then(|m| m.fitness_goals.as_ref())
        .is_some_and(|goals| !goals.is_empty())
}

/// `member_id`'s status for `date`; all zeros when nothing was logged.
pub(crate) async fn member_status(
    pool: &SqlitePool,
    config: &AppConfig,
    member_id: &str,
    date: NaiveDate,
) -> Result<Option<MemberStatus>> {
    let date_str = date.format("%Y-%m-%d").to_string();
    let healths = crate::reflection::daily_health_summaries(pool, &date_str, config).await?;
    Ok(
        member_statuses(pool, config, &healths, Some(member_id), date)
            .await
            .into_iter()
            .next(),
    )
}

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

    /// Alex's plan for the week of `monday`, Monday's lifts, and Tuesday's run.
    pub(crate) async fn seed_plan(pool: &SqlitePool, monday: NaiveDate) -> StoredWeeklyPlan {
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
                chotu_common::family::WeightUnit::Lb,
            )
            .await
            .unwrap();
        }
        health_coach::close_workout(
            pool,
            "alex",
            at,
            monday,
            chotu_common::family::WeightUnit::Lb,
        )
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
