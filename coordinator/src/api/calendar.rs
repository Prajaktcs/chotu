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
    /// Household time: `all day`, `09:30–10:00`, or `until 10:00` for an
    /// event that began on an earlier day.
    when: String,
    location: Option<String>,
}

impl EventBody {
    fn new(event: CalendarEvent, day_start: DateTime<Utc>, tz: Tz) -> Self {
        let all_day = is_all_day(&event);
        let time = |at: DateTime<Utc>| at.with_timezone(&tz).format("%H:%M").to_string();
        let when = if all_day {
            "all day".to_string()
        } else if event.start < day_start {
            format!("until {}", time(event.end))
        } else {
            format!("{}–{}", time(event.start), time(event.end))
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
    let fetch = fetch_family_events(&config, from, to, Some(&member_id)).await;
    if !fetch.errors.is_empty() {
        return Err(ApiError::RejectedWithCode(
            StatusCode::BAD_GATEWAY,
            "calendar_failed",
            "Google Calendar didn't answer. Try again later.".into(),
        ));
    }
    let mut events: Vec<EventBody> = fetch
        .events
        .into_iter()
        .map(|event| EventBody::new(event, from, tz))
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
        let (day_start, _) = civil_day_bounds_utc("2026-11-02", tz).unwrap();
        let at = |h, m| Utc.with_ymd_and_hms(2026, 11, 2, h, m, 0).unwrap();
        // 14:30Z is 09:30 in Toronto (EST).
        let timed = EventBody::new(event(at(14, 30), at(15, 0)), day_start, tz);
        assert_eq!(timed.when, "09:30–10:00");
        assert!(!timed.all_day);
        assert_eq!(timed.location, None);
        let overnight = EventBody::new(
            event(
                Utc.with_ymd_and_hms(2026, 11, 1, 23, 0, 0).unwrap(),
                at(13, 0),
            ),
            day_start,
            tz,
        );
        assert_eq!(overnight.when, "until 08:00");
        let all_day = EventBody::new(
            event(
                Utc.with_ymd_and_hms(2026, 11, 2, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2026, 11, 3, 0, 0, 0).unwrap(),
            ),
            day_start,
            tz,
        );
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
