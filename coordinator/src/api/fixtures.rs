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
    let profile = |weight_unit| Profile {
        id: format!("example-member-{weight_unit:?}").to_lowercase(),
        name: "Example Member".into(),
        weight_unit,
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
                member: Some(profile(chotu_common::family::WeightUnit::Lb)),
                profiles: vec![
                    profile(chotu_common::family::WeightUnit::Lb),
                    profile(chotu_common::family::WeightUnit::Kg),
                ],
            },
        ),
        example(
            "me-no-member",
            Me {
                device: "example-device".into(),
                member: None,
                profiles: vec![
                    profile(chotu_common::family::WeightUnit::Lb),
                    profile(chotu_common::family::WeightUnit::Kg),
                ],
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

fn write_examples(directory: &std::path::Path, expected: BTreeMap<&str, Value>) {
    std::fs::create_dir_all(directory).unwrap();
    for entry in std::fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_file()
            && path
                .extension()
                .is_some_and(|extension| extension == "json")
            && !expected.contains_key(path.file_stem().unwrap().to_str().unwrap())
        {
            std::fs::remove_file(path).unwrap();
        }
    }
    for (name, body) in expected {
        std::fs::write(directory.join(format!("{name}.json")), render(&body)).unwrap();
    }
}

#[test]
fn regeneration_removes_only_obsolete_json_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path();
    std::fs::write(path.join("obsolete.json"), "{}").unwrap();
    std::fs::write(path.join("retained.txt"), "not a fixture").unwrap();
    std::fs::create_dir(path.join("nested.json")).unwrap();
    std::fs::write(path.join("nested.json/untouched.json"), "{}").unwrap();
    let body = serde_json::json!({"synthetic": true});
    write_examples(path, [("current", body.clone())].into_iter().collect());
    assert!(!path.join("obsolete.json").exists());
    assert_eq!(
        std::fs::read_to_string(path.join("current.json")).unwrap(),
        render(&body)
    );
    assert_eq!(
        std::fs::read_to_string(path.join("retained.txt")).unwrap(),
        "not a fixture"
    );
    assert!(path.join("nested.json/untouched.json").is_file());
}

#[tokio::test]
#[ignore = "writes checked-in API fixtures; run just api-fixtures"]
async fn regenerate_api_fixtures() {
    write_examples(&directory(), examples().await);
}
