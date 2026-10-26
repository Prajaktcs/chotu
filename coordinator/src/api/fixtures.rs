//! Synthetic wire examples, serialized from the same DTOs as the handlers.
//! Run `just api-fixtures` after intentional API changes.
use super::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub(super) type Examples = Vec<(&'static str, Value)>;

pub(super) fn example(name: &'static str, body: impl Serialize) -> (&'static str, Value) {
    (
        name,
        serde_json::to_value(body).expect("serialize API example"),
    )
}

async fn examples() -> BTreeMap<&'static str, Value> {
    let profile = || Profile {
        id: "example-member".into(),
        name: "Example Member".into(),
    };
    let mut examples = vec![
        example(
            "health",
            Health {
                status: "ok",
                server_version: "0.1.0+example",
                min_app_version: MIN_APP_VERSION.to_string(),
            },
        ),
        example(
            "me",
            Me {
                device: "example-device".into(),
                member: Some(profile()),
                profiles: vec![profile()],
            },
        ),
        example(
            "me-no-member",
            Me {
                device: "example-device".into(),
                member: None,
                profiles: vec![profile()],
            },
        ),
    ];
    examples.extend(workout::fixture_examples::examples());
    examples.extend(tasks::fixture_examples::examples());
    examples.extend(status::fixture_examples::examples());
    examples.extend(plan::fixture_examples::examples());
    // Exercise the actual error response path, including its 426-only field.
    for (name, error) in [
        ("error", ApiError::Unauthorized),
        (
            "error-coded",
            ApiError::RejectedWithCode(
                StatusCode::UNPROCESSABLE_ENTITY,
                "too_old",
                "example rejection".into(),
            ),
        ),
        ("error-426", ApiError::UpgradeRequired),
    ] {
        let response = error.into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        examples.push((name, serde_json::from_slice(&bytes).unwrap()));
    }
    let count = examples.len();
    let examples: BTreeMap<_, _> = examples.into_iter().collect();
    assert_eq!(examples.len(), count, "duplicate fixture name");
    examples
}

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/src/api/fixtures")
}

fn render(body: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(body).unwrap())
}

#[tokio::test]
async fn api_fixtures_are_current() {
    let expected = examples().await;
    let directory = directory();
    let actual: std::collections::BTreeSet<_> = std::fs::read_dir(&directory)
        .expect("missing API fixtures: run just api-fixtures")
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    let names = expected.keys().map(|name| format!("{name}.json")).collect();
    assert_eq!(
        actual, names,
        "API fixture inventory differs: run just api-fixtures"
    );
    for (name, body) in expected {
        let path = directory.join(format!("{name}.json"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            render(&body),
            "stale {}: run just api-fixtures",
            path.display()
        );
    }
}

#[tokio::test]
#[ignore = "writes checked-in API fixtures; run just api-fixtures"]
async fn regenerate_api_fixtures() {
    let directory = directory();
    std::fs::create_dir_all(&directory).unwrap();
    for (name, body) in examples().await {
        std::fs::write(directory.join(format!("{name}.json")), render(&body)).unwrap();
    }
}
