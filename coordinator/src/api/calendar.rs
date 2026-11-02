//! `GET /v1/calendar`: the chosen profile's calendar for today, through the
//! same [`chotu_common::fetch_family_events`] Signal's `/cal` and the morning
//! brief use, limited to that member as in a linked DM. Never another
//! member's calendar, and no OAuth from the app (`/login calendar` stays in
//! Signal).

use super::workout::{clock, member_id};
use super::{ApiError, Caller};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chotu_common::agenda::is_all_day;
use chotu_common::{civil_day_bounds_utc, fetch_family_events, AppConfig, CalendarEvent};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use std::sync::Arc;

#[cfg(test)]
#[path = "fixtures/calendar.rs"]
pub(super) mod fixture_examples;

/// The whole Google fetch, token refresh and pages included.
const CALENDAR_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Serialize)]
pub(super) struct CalendarResponse {
    /// Household-timezone day, `YYYY-MM-DD`.
    date: String,
    /// `false` when this member has no linked Google Calendar; `events` is
    /// then empty and means nothing.
    linked: bool,
    /// Accepted or tentative events overlapping the day, by start time.
    events: Vec<EventBody>,
}

#[derive(Debug, Serialize)]
struct EventBody {
    id: String,
    title: String,
    /// RFC 3339.
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    all_day: bool,
    /// Household time: `all day`, `09:30–10:00`, or with the weekday on an
    /// end outside the day: `Sun 23:00–08:00`, `22:00–Tue 01:00`.
    when: String,
    location: Option<String>,
}

impl EventBody {
    fn new(
        event: CalendarEvent,
        (day_start, day_end): (DateTime<Utc>, DateTime<Utc>),
        tz: Tz,
    ) -> Self {
        let all_day = is_all_day(&event);
        // An end on another day names its weekday, so an overnight event
        // never reads as ending this morning.
        let time = |at: DateTime<Utc>, inside: bool| {
            let local = at.with_timezone(&tz);
            if inside {
                local.format("%H:%M").to_string()
            } else {
                local.format("%a %H:%M").to_string()
            }
        };
        let when = if all_day {
            "all day".to_string()
        } else {
            format!(
                "{}–{}",
                time(event.start, event.start >= day_start),
                time(event.end, event.end <= day_end),
            )
        };
        Self {
            id: event.id,
            title: event.title,
            start: event.start,
            end: event.end,
            all_day,
            when,
            location: event
                .location
                .filter(|location| !location.trim().is_empty()),
        }
    }
}

/// `GET /v1/calendar`: today's events for the caller. Read-only. A Google
/// failure is `502 calendar_failed`, distinct from not linked and from a day
/// with no events.
pub(super) async fn get_calendar(
    caller: Caller,
    State(config): State<Arc<AppConfig>>,
    State(tz): State<Tz>,
) -> Result<Json<CalendarResponse>, ApiError> {
    let member_id = member_id(caller)?;
    let (_, today) = clock(tz);
    let date = today.format("%Y-%m-%d").to_string();
    let (from, to) = civil_day_bounds_utc(&date, tz).map_err(|error| {
        eprintln!("api_calendar bounds failed: {error:?}");
        ApiError::Internal
    })?;
    let failed = || {
        ApiError::RejectedWithCode(
            StatusCode::BAD_GATEWAY,
            "calendar_failed",
            "Google Calendar didn't answer. Try again later.".into(),
        )
    };
    // Token refresh and every page included, so a stalled Google answer
    // can't hold Today's pull to refresh open.
    let fetch = tokio::time::timeout(
        CALENDAR_DEADLINE,
        fetch_family_events(&config, from, to, Some(&member_id)),
    )
    .await
    .map_err(|_| {
        eprintln!("api_calendar timed out for {member_id}");
        failed()
    })?;
    if !fetch.errors.is_empty() {
        return Err(failed());
    }
    let mut events: Vec<EventBody> = fetch
        .events
        .into_iter()
        .map(|event| EventBody::new(event, (from, to), tz))
        .collect();
    // All-day events first, as Signal's timeline lists them.
    events.sort_by_key(|event| (!event.all_day, event.start));
    Ok(Json(CalendarResponse {
        date,
        linked: fetch.any_client,
        events,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{get_json, serve_router, test_pool, ALEX_PHONE, KITCHEN_IPAD};
    use super::*;
    use crate::status::fixtures;
    use chrono::TimeZone;
    use serde_json::json;

    fn event(start: DateTime<Utc>, end: DateTime<Utc>) -> CalendarEvent {
        CalendarEvent {
            id: "e1".into(),
            title: "Dentist".into(),
            start,
            end,
            location: Some(" ".into()),
            description: None,
            member_name: "Alex".into(),
            response_status: None,
        }
    }

    #[test]
    fn event_times_are_household_time() {
        let tz: Tz = "America/Toronto".parse().unwrap();
        let day = civil_day_bounds_utc("2026-11-02", tz).unwrap();
        let at = |d, h, m| Utc.with_ymd_and_hms(2026, 11, d, h, m, 0).unwrap();
        // 14:30Z is 09:30 in Toronto (EST).
        let timed = EventBody::new(event(at(2, 14, 30), at(2, 15, 0)), day, tz);
        assert_eq!(timed.when, "09:30–10:00");
        assert!(!timed.all_day);
        assert_eq!(timed.location, None);
        // Sun 18:00 → Mon 08:00 Toronto: the start names its day.
        let overnight = EventBody::new(event(at(1, 23, 0), at(2, 13, 0)), day, tz);
        assert_eq!(overnight.when, "Sun 18:00–08:00");
        // Started yesterday, ends tomorrow morning: both ends are dated.
        let spanning = EventBody::new(event(at(1, 23, 0), at(3, 13, 0)), day, tz);
        assert_eq!(spanning.when, "Sun 18:00–Tue 08:00");
        // Ending exactly at midnight stays undated.
        let late = EventBody::new(event(at(3, 3, 0), at(3, 5, 0)), day, tz);
        assert_eq!(late.when, "22:00–00:00");
        let all_day = EventBody::new(event(at(2, 0, 0), at(3, 0, 0)), day, tz);
        assert_eq!(all_day.when, "all day");
    }

    #[tokio::test]
    async fn calendar_is_the_chosen_members_only_and_says_when_not_linked() {
        let (_dir, pool) = test_pool().await;
        let (server, base) = serve_router(pool, fixtures::config()).await;
        assert_eq!(get_json(&base, "/v1/calendar", None, None).await.0, 401);
        assert_eq!(
            get_json(&base, "/v1/calendar", Some(ALEX_PHONE), None)
                .await
                .0,
            400
        );
        assert_eq!(
            get_json(&base, "/v1/calendar", Some(ALEX_PHONE), Some("jordan"))
                .await
                .0,
            403
        );
        let (status, body) =
            get_json(&base, "/v1/calendar", Some(KITCHEN_IPAD), Some("jordan")).await;
        assert_eq!(status, 200);
        assert_eq!(body["linked"], json!(false));
        assert_eq!(body["events"], json!([]));
        assert_eq!(
            body["date"],
            json!(Utc::now().format("%Y-%m-%d").to_string())
        );
        server.shutdown().await;
    }
}
