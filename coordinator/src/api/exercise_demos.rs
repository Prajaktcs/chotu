//! Curated sources: https://www.youtube.com/watch?v=<video_id>.
//! Titles and creators are retained here for review; only IDs leave the API.
struct Demo {
    keys: &'static [&'static str],
    video_id: &'static str,
    _title: &'static str,
    _creator: &'static str,
}

const DEMOS: &[Demo] = &[
    Demo {
        keys: &["benchpress", "barbellbenchpress"],
        video_id: "rT7DgCr-3pg",
        _title: "How To: Barbell Bench Press",
        _creator: "ScottHermanFitness",
    },
    Demo {
        keys: &["legpress", "seatedlegpress"],
        video_id: "IZxyjW7MPJQ",
        _title: "How To: Seated Leg Press (Cybex)",
        _creator: "ScottHermanFitness",
    },
    Demo {
        keys: &["latpulldown", "latpulldowns"],
        video_id: "CAwf7n6Luuc",
        _title: "How To: Lat Pulldown, 3 GOLDEN RULES",
        _creator: "ScottHermanFitness",
    },
    Demo {
        keys: &["barbellsquat", "barbellbacksquat", "backsquat"],
        video_id: "nFAscG0XUNY",
        _title: "How To: Squat (Feet Shoulder Width)",
        _creator: "ScottHermanFitness",
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
