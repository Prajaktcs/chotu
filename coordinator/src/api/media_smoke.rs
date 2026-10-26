//! Opt-in browser smoke server: synthetic fixtures only, isolated database/cache.
//! Run with CHOTU_MEDIA_SMOKE_DIR containing video.mp4 and poster.jpg.

use super::{media::MediaRegistry, tests, ApiServer, ApiState};
use chotu_common::{family::ExerciseMediaConfig, MemoryIndex};
use chrono::Utc;
use std::{path::PathBuf, sync::Arc};
use tokio::net::TcpListener;

#[tokio::test]
#[ignore = "manual browser smoke; requires synthetic media and stays running until Ctrl-C"]
async fn media_browser_smoke_server() {
    let dir =
        PathBuf::from(std::env::var("CHOTU_MEDIA_SMOKE_DIR").expect("set CHOTU_MEDIA_SMOKE_DIR"));
    let video = std::fs::read(dir.join("video.mp4")).expect("generate synthetic video.mp4");
    let poster = std::fs::read(dir.join("poster.jpg")).expect("generate synthetic poster.jpg");
    let video_sha256 = super::media::tests::hash(&video);
    let poster_sha256 = super::media::tests::hash(&poster);
    let mut config = crate::status::fixtures::config();
    let names = [
        "Bench press",
        "Squat",
        "Deadlift",
        "Row",
        "Overhead press",
        "Pull-ups",
        "Lunge",
        "Plank",
    ];
    for name in names {
        config.exercise_media.insert(
            health_coach::exercise_key(name),
            ExerciseMediaConfig {
                video_url: "https://example.com/synthetic-only.mp4".into(),
                poster_url: "https://example.com/synthetic-only.jpg".into(),
                video_sha256: video_sha256.clone(),
                poster_sha256: poster_sha256.clone(),
            },
        );
    }
    let (_database, pool) = tests::test_pool().await;
    let mut plan = crate::status::fixtures::plan();
    for day in &mut plan.days {
        day.kind = health_coach::PlanDayKind::Strength;
        day.exercises = names
            .iter()
            .map(|name| health_coach::PlanExercise {
                name: (*name).into(),
                sets: 3,
                reps: "8-10".into(),
            })
            .collect();
    }
    let monday = health_coach::week_start_monday(Utc::now().date_naive());
    health_coach::save_weekly_plan(&pool, "alex", &monday.format("%Y-%m-%d").to_string(), &plan)
        .await
        .unwrap();
    let mut media = MediaRegistry::new(&config).unwrap();
    media.cache_dir = dir.join("cache");
    std::fs::create_dir_all(&media.cache_dir).unwrap();
    std::fs::write(media.cache_dir.join(format!("{video_sha256}.video")), video).unwrap();
    std::fs::write(
        media.cache_dir.join(format!("{poster_sha256}.poster")),
        poster,
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = ApiState {
        pool,
        tz: chrono_tz::Tz::UTC,
        config: Arc::new(config),
        memory: MemoryIndex::with_base_url("http://127.0.0.1:0", "unused"),
        media: Arc::new(media),
    };
    let server = ApiServer::spawn(listener, super::router(tests::test_auth(), state));
    std::fs::write(
        dir.join("connection.json"),
        serde_json::to_vec(&serde_json::json!({
            "base": base, "token": tests::ALEX_PHONE,
            "video_path": format!("/v1/exercise-media/{video_sha256}/video"),
            "poster_path": format!("/v1/exercise-media/{poster_sha256}/poster"),
        }))
        .unwrap(),
    )
    .unwrap();
    println!("MEDIA_SMOKE_READY {base}");
    tokio::signal::ctrl_c().await.unwrap();
    server.shutdown().await;
}
