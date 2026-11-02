use super::*;
use crate::api::fixtures::{example, Examples};
use chrono::TimeZone;

pub(in crate::api) fn examples() -> Examples {
    let at = |h, m| Utc.with_ymd_and_hms(2026, 10, 26, h, m, 0).unwrap();
    vec![
        example(
            "calendar",
            CalendarResponse {
                date: "2026-10-26".into(),
                linked: true,
                events: vec![
                    EventBody {
                        id: "example-all-day".into(),
                        title: "Example holiday".into(),
                        start: at(0, 0),
                        end: Utc.with_ymd_and_hms(2026, 10, 27, 0, 0, 0).unwrap(),
                        all_day: true,
                        when: "all day".into(),
                        location: None,
                    },
                    EventBody {
                        id: "example-timed".into(),
                        title: "Example appointment".into(),
                        start: at(13, 30),
                        end: at(14, 0),
                        all_day: false,
                        when: "09:30–10:00".into(),
                        location: Some("Example clinic".into()),
                    },
                ],
            },
        ),
        example(
            "calendar-not-linked",
            CalendarResponse {
                date: "2026-10-26".into(),
                linked: false,
                events: vec![],
            },
        ),
    ]
}
