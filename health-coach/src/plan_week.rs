//! This week's training plan as data. Signal's `/plan` renders it as text and
//! the app API serves it as JSON, so both show the same plan, targets and
//! progress for the same day.

use anyhow::Result;
use chotu_common::family::WeightUnit;
use chrono::NaiveDate;
use sqlx::SqlitePool;

use crate::coach_enrich::{plan_week_progress, PlanProgress};
use crate::fitness_plan::{
    load_weekly_plan, parse_plan_json, render_today_session, session_for_date, week_start_monday,
    PlanDay, StoredWeeklyPlan, WeeklyFitnessPlan,
};
use crate::strength_log::{plan_targets, target_suffixes, Target};

/// A member's stored plan for one week, read as of a day in it.
#[derive(Debug, Clone)]
pub struct PlanWeek {
    /// Monday, `YYYY-MM-DD`.
    pub week_start: String,
    /// The plan as Signal shows it, rendered when it was generated.
    pub plan_md: String,
    /// `None` when the stored JSON no longer parses.
    pub plan: Option<WeeklyFitnessPlan>,
    /// The day's session, rest days included; `None` outside the week.
    pub today: Option<PlanToday>,
    /// `None` when the week's logs could not be read.
    pub progress: Option<PlanProgress>,
}

/// One day's session and the next target for each of its exercises.
#[derive(Debug, Clone)]
pub struct PlanToday {
    pub day: PlanDay,
    /// Aligned with `day.exercises`; `None` for timed work or when targets
    /// could not be read.
    pub targets: Vec<Option<Target>>,
}

impl PlanWeek {
    /// The `/plan` reply: the plan, today's session with targets, and progress.
    pub fn signal_text(&self, unit: WeightUnit) -> String {
        let mut msg = self.plan_md.clone();
        if let Some(today) = &self.today {
            msg.push_str(&render_today_session(
                &today.day,
                &target_suffixes(&today.targets, unit),
            ));
        }
        if let Some(progress) = &self.progress {
            msg.push('\n');
            msg.push_str(&progress.line());
            msg.push('\n');
        }
        msg
    }
}

/// Which parts of the week to read: today's targets cost a query per exercise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanRead {
    /// Everything `/plan` shows, today's targets included.
    WithTargets,
    /// The plan, today's session and progress; every target is `None` (the
    /// morning brief, which shows no targets).
    WithoutTargets,
}

/// Reads `stored` as of `today`. Targets and progress that cannot be read are
/// left out (as `/plan` always has) rather than failing the whole plan.
pub async fn plan_week(
    pool: &SqlitePool,
    member_id: &str,
    stored: &StoredWeeklyPlan,
    today: NaiveDate,
    unit: WeightUnit,
) -> PlanWeek {
    read_plan_week(pool, member_id, stored, today, PlanRead::WithTargets, unit).await
}

/// [`plan_week`], reading only what `read` asks for. The one place the stored
/// plan's JSON is parsed for a week's view.
pub async fn read_plan_week(
    pool: &SqlitePool,
    member_id: &str,
    stored: &StoredWeeklyPlan,
    today: NaiveDate,
    read: PlanRead,
    unit: WeightUnit,
) -> PlanWeek {
    let plan = parse_plan_json(&stored.plan_json).ok();
    let day = plan
        .as_ref()
        .and_then(|plan| session_for_date(&stored.week_start, plan, today).cloned());
    let today_session = match day {
        Some(day) => {
            let targets = match read {
                PlanRead::WithTargets => plan_targets(pool, member_id, today, &day.exercises, unit)
                    .await
                    .unwrap_or_else(|error| {
                        eprintln!("Workout targets unavailable: {error:?}");
                        vec![None; day.exercises.len()]
                    }),
                PlanRead::WithoutTargets => vec![None; day.exercises.len()],
            };
            Some(PlanToday { day, targets })
        }
        None => None,
    };
    let progress = match &plan {
        Some(plan) => plan_week_progress(pool, member_id, &stored.week_start, plan, today).await,
        None => None,
    };
    PlanWeek {
        week_start: stored.week_start.clone(),
        plan_md: stored.plan_md.clone(),
        plan,
        today: today_session,
        progress,
    }
}

/// The member's plan for the week containing `today`, if one was generated.
/// Read-only: never generates a plan.
pub async fn current_plan_week(
    pool: &SqlitePool,
    member_id: &str,
    today: NaiveDate,
    read: PlanRead,
    unit: WeightUnit,
) -> Result<Option<PlanWeek>> {
    let week_start = week_start_monday(today).format("%Y-%m-%d").to_string();
    let Some(stored) = load_weekly_plan(pool, member_id, &week_start).await? else {
        return Ok(None);
    };
    Ok(Some(
        read_plan_week(pool, member_id, &stored, today, read, unit).await,
    ))
}
