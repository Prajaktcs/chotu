//! Curated sources: https://www.youtube.com/watch?v=<video_id>.
//! Titles and creators are retained here for review; only IDs leave the API.
//!
//! Pick the shortest video that still shows full form: ideally ≤ 60 s and at
//! most 2 min, landscape (the player is 16:9), ≥ 1080p, ≥ 100k views with a
//! high like count from an established creator, embeddable and not
//! age-restricted. Last checked 2026-10-30.
struct Demo {
    keys: &'static [&'static str],
    video_id: &'static str,
    _title: &'static str,
    _creator: &'static str,
}

const DEMOS: &[Demo] = &[
    Demo {
        keys: &["benchpress", "barbellbenchpress"],
        video_id: "SCVCLChPQFY",
        _title: "The Bench Press",
        _creator: "CrossFit",
    },
    Demo {
        keys: &["legpress", "seatedlegpress"],
        video_id: "8EMbB0tCn7Q",
        _title: "HOW TO: Seated Leg Press",
        _creator: "Goodlife Health Clubs",
    },
    Demo {
        keys: &["latpulldown", "latpulldowns"],
        video_id: "qMLOzlpHvDk",
        _title: "Lat pulldowns should only be done like this",
        _creator: "mountaindog1",
    },
    Demo {
        keys: &["barbellsquat", "barbellbacksquat", "backsquat"],
        video_id: "ultWZbUMPL8",
        _title: "The Back Squat",
        _creator: "CrossFit",
    },
    Demo {
        keys: &["plank", "forearmplank"],
        video_id: "pSHjTRCQxIw",
        _title: "How To: Plank",
        _creator: "ScottHermanFitness",
    },
];

pub(super) fn for_key(key: &str) -> Option<&'static str> {
    DEMOS
        .iter()
        .find(|demo| demo.keys.contains(&key))
        .map(|demo| demo.video_id)
}
