//! Public, content-addressed access to operator-curated assets only. No caller
//! credentials or household state enter the upstream request or disk cache.
use super::ApiState;
use anyhow::{anyhow, bail, Context, Result};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chotu_common::AppConfig;
use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, Semaphore};

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ExerciseMedia {
    Hosted {
        video_url: String,
        poster_url: String,
    },
    Youtube {
        video_id: String,
    },
}

/// Media configuration keys must stay canonical after Unicode case expansion.
/// Keep this separate from persisted strength-log keys, whose identity is unchanged.
fn media_key(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

pub(super) fn for_exercise(config: &AppConfig, name: &str) -> Option<ExerciseMedia> {
    use chotu_common::family::ExerciseMediaConfig;
    let key = media_key(name);
    match config.exercise_media.get(&key) {
        Some(ExerciseMediaConfig::Hosted {
            video_sha256,
            poster_sha256,
            ..
        }) => Some(ExerciseMedia::Hosted {
            video_url: format!("/v1/exercise-media/{video_sha256}/video"),
            poster_url: format!("/v1/exercise-media/{poster_sha256}/poster"),
        }),
        Some(ExerciseMediaConfig::Youtube { video_id }) => Some(ExerciseMedia::Youtube {
            video_id: video_id.clone(),
        }),
        None => super::exercise_demos::for_key(&key).map(|video_id| ExerciseMedia::Youtube {
            video_id: video_id.into(),
        }),
    }
}

fn valid_youtube_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Video,
    Poster,
}

impl Kind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "video" => Some(Self::Video),
            "poster" => Some(Self::Poster),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Poster => "poster",
        }
    }
    fn limit(self) -> usize {
        match self {
            Self::Video => 2 * 1024 * 1024,
            Self::Poster => 50 * 1024,
        }
    }
}

struct Asset {
    url: Url,
    hash: String,
    kind: Kind,
    // One downloader per immutable asset; waiters read the verified disk cache.
    fetch: Mutex<()>,
}

pub(super) struct MediaRegistry {
    assets: HashMap<(String, Kind), Asset>,
    pub(super) cache_dir: PathBuf,
    downloads: Semaphore,
}

impl MediaRegistry {
    pub(super) fn new(config: &AppConfig) -> Result<Self> {
        let cache_dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".cache/chotu/exercise-media");
        let mut assets = HashMap::new();
        for (key, entry) in &config.exercise_media {
            if key.is_empty() || media_key(key) != *key {
                bail!("exercise_media keys must be normalized nonempty exercise keys");
            }
            use chotu_common::family::ExerciseMediaConfig;
            let (video_url, poster_url, video_sha256, poster_sha256) = match entry {
                ExerciseMediaConfig::Hosted {
                    video_url,
                    poster_url,
                    video_sha256,
                    poster_sha256,
                } => (video_url, poster_url, video_sha256, poster_sha256),
                ExerciseMediaConfig::Youtube { video_id } => {
                    if !valid_youtube_id(video_id) {
                        bail!(
                            "exercise_media YouTube IDs must be eleven ASCII URL-safe characters"
                        );
                    }
                    continue;
                }
            };
            for (kind, raw_url, hash) in [
                (Kind::Video, video_url, video_sha256),
                (Kind::Poster, poster_url, poster_sha256),
            ] {
                if hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    bail!("exercise_media SHA256 must be 64 lowercase hexadecimal characters");
                }
                let url = safe_url(raw_url).context("Invalid exercise_media URL")?;
                let map_key = (hash.clone(), kind);
                if let Some(existing) = assets.get(&map_key) {
                    let existing: &Asset = existing;
                    if existing.url != url {
                        bail!("Conflicting URLs for exercise_media hash");
                    }
                } else {
                    assets.insert(
                        map_key,
                        Asset {
                            url,
                            hash: hash.clone(),
                            kind,
                            fetch: Mutex::new(()),
                        },
                    );
                }
            }
        }
        Ok(Self {
            assets,
            cache_dir,
            downloads: Semaphore::new(2),
        })
    }

    async fn bytes(&self, asset: &Asset) -> Result<(Vec<u8>, &'static str)> {
        let _guard = tokio::time::timeout(FETCH_TIMEOUT, asset.fetch.lock())
            .await
            .context("Media singleflight wait timed out")?;
        let path = self
            .cache_dir
            .join(format!("{}.{}", asset.hash, asset.kind.name()));
        if let Ok(file) = tokio::fs::File::open(&path).await {
            let mut bytes = Vec::new();
            file.take(asset.kind.limit() as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if let Ok(mime) = verify(&bytes, &asset.hash, asset.kind, None) {
                return Ok((bytes, mime));
            }
            // Never serve a stale, oversized or tampered cache entry.
            tokio::fs::remove_file(&path).await?;
        }
        let _permit = tokio::time::timeout(FETCH_TIMEOUT, self.downloads.acquire())
            .await
            .context("Media download queue timed out")??;
        let (bytes, mime) = tokio::time::timeout(FETCH_TIMEOUT, fetch(asset))
            .await
            .context("Media fetch timed out")??;
        tokio::fs::create_dir_all(&self.cache_dir).await?;
        let temp = self
            .cache_dir
            .join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let saved = async {
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .await?;
            use tokio::io::AsyncWriteExt;
            file.write_all(&bytes).await?;
            file.flush().await?;
            tokio::fs::rename(&temp, &path).await
        }
        .await;
        if saved.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        saved.context("Failed to cache verified exercise media")?;
        Ok((bytes, mime))
    }
}

fn safe_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)?;
    let authority = raw
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""));
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || authority.is_some_and(|value| value.contains('@'))
    {
        bail!("Media URLs require HTTPS port 443 without credentials or fragments");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("Media URL needs a host"))?;
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        if !public_ip(ip) {
            bail!("Media URL is not public");
        }
    } else if host.eq_ignore_ascii_case("localhost") || !host.contains('.') {
        bail!("Media URL needs a public host");
    }
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Only global unicast; exclude special-use, documentation and
            // transition ranges (including mapped IPv4, NAT64 and 6to4).
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && (s[0] & 0xfff0) != 0x3ff0
        }
    }
}

async fn fetch(asset: &Asset) -> Result<(Vec<u8>, &'static str)> {
    let host = asset
        .url
        .host_str()
        .ok_or_else(|| anyhow!("Missing media host"))?;
    let host = host.trim_matches(['[', ']']);
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 443)).await?.collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        bail!("Media DNS resolved to a non-public address");
    }
    // A new, credential-free client pins this resolution for the TLS request.
    // Do not use the household's HTTP clients, proxy environment or redirects.
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .cookie_store(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(FETCH_TIMEOUT)
        .resolve_to_addrs(host, &addresses)
        .build()?;
    let mut response = client
        .get(asset.url.clone())
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await?;
    if response.status() != StatusCode::OK {
        bail!("Media upstream did not return 200");
    }
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v != "identity")
    {
        bail!("Encoded upstream media is not accepted");
    }
    if response
        .content_length()
        .is_some_and(|n| n > asset.kind.limit() as u64)
    {
        bail!("Media exceeds its size limit");
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > asset.kind.limit() - bytes.len() {
            bail!("Media exceeds its size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    let mime = verify(&bytes, &asset.hash, asset.kind, Some(&content_type))?;
    Ok((bytes, mime))
}

fn verify(
    bytes: &[u8],
    hash: &str,
    kind: Kind,
    content_type: Option<&str>,
) -> Result<&'static str> {
    if bytes.is_empty() || bytes.len() > kind.limit() {
        bail!("Invalid media size");
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    if hash.len() != 64
        || !digest
            .iter()
            .zip(hash.as_bytes().chunks_exact(2))
            .all(|(byte, hex)| {
                hex[0] == HEX[usize::from(byte >> 4)] && hex[1] == HEX[usize::from(byte & 15)]
            })
    {
        bail!("Media SHA256 mismatch");
    }
    let mime = match kind {
        Kind::Video
            if bytes.len() >= 16
                && &bytes[4..8] == b"ftyp"
                && [b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"M4V "]
                    .iter()
                    .any(|brand| &bytes[8..12] == *brand) =>
        {
            "video/mp4"
        }
        Kind::Poster if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        Kind::Poster if bytes.starts_with(b"\xff\xd8\xff") => "image/jpeg",
        Kind::Poster if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            "image/webp"
        }
        _ => bail!("Unsupported media type"),
    };
    if content_type.is_some_and(|value| value != mime) {
        bail!("Media Content-Type mismatch");
    }
    Ok(mime)
}

pub(super) async fn get_media(
    State(registry): State<Arc<MediaRegistry>>,
    Path((hash, kind)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(kind) = Kind::parse(&kind) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(asset) = registry.assets.get(&(hash, kind)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match registry.bytes(asset).await {
        Ok((bytes, mime)) => {
            media_response(bytes, mime, &asset.hash, method == Method::HEAD, &headers)
        }
        Err(_) => StatusCode::BAD_GATEWAY.into_response(), // Do not expose curated URLs or DNS details.
    }
}

impl axum::extract::FromRef<ApiState> for Arc<MediaRegistry> {
    fn from_ref(state: &ApiState) -> Self {
        state.media.clone()
    }
}

fn byte_range(value: &str, len: usize) -> Option<(usize, usize)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<usize>().ok()
        } else {
            None
        }
    };
    if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return None;
        }
        Some((len.saturating_sub(suffix), len.checked_sub(1)?))
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            len.checked_sub(1)?
        } else {
            number(end)?.min(len.checked_sub(1)?)
        };
        (start < len && start <= end).then_some((start, end))
    }
}

fn media_response(
    bytes: Vec<u8>,
    mime: &'static str,
    hash: &str,
    head: bool,
    headers: &HeaderMap,
) -> Response {
    let etag = format!("\"{hash}\"");
    let len = bytes.len();
    let mut response = Response::new(Body::empty());
    let output = response.headers_mut();
    output.insert(
        header::CACHE_CONTROL,
        "public, max-age=31536000, immutable".parse().unwrap(),
    );
    output.insert(header::ETAG, etag.parse().unwrap());
    output.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    output.insert(header::CONTENT_TYPE, mime.parse().unwrap());
    output.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    if headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| {
            v.split(',')
                .map(str::trim)
                .any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag)
        })
    {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        return response;
    }
    let range = headers.get(header::RANGE).filter(|_| !head).filter(|_| {
        headers.get_all(header::IF_RANGE).iter().count() <= 1
            && headers
                .get(header::IF_RANGE)
                .is_none_or(|v| v.to_str().ok() == Some(etag.as_str()))
    });
    let (start, end) = if let Some(range) = range {
        match (headers.get_all(header::RANGE).iter().count() == 1)
            .then(|| range.to_str().ok().and_then(|v| byte_range(v, len)))
            .flatten()
        {
            Some((start, end)) => {
                *response.status_mut() = StatusCode::PARTIAL_CONTENT;
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{len}").parse().unwrap(),
                );
                (start, end)
            }
            None => {
                *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes */{len}").parse().unwrap(),
                );
                response
                    .headers_mut()
                    .insert(header::CONTENT_LENGTH, "0".parse().unwrap());
                return response;
            }
        }
    } else {
        (0, len - 1)
    };
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        (end - start + 1).to_string().parse().unwrap(),
    );
    if !head {
        // Bytes owns the verified buffer; slicing a range does not copy it.
        let bytes = axum::body::Bytes::from(bytes);
        *response.body_mut() = Body::from(bytes.slice(start..=end));
    }
    response
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use chotu_common::family::ExerciseMediaConfig;

    pub(crate) fn hash(bytes: &[u8]) -> String {
        use std::fmt::Write;
        let mut output = String::with_capacity(64);
        for byte in Sha256::digest(bytes) {
            write!(&mut output, "{byte:02x}").unwrap();
        }
        output
    }
    pub(crate) fn config() -> AppConfig {
        let mut config = AppConfig::default();
        config.exercise_media.insert(
            "benchpress".into(),
            ExerciseMediaConfig::Hosted {
                video_url: "https://example.com/demo.mp4".into(),
                poster_url: "https://example.com/demo.jpg".into(),
                video_sha256: "a".repeat(64),
                poster_sha256: "b".repeat(64),
            },
        );
        config
    }

    #[test]
    fn curated_mapping_is_optional_and_first_party() {
        assert!(AppConfig::default().exercise_media.is_empty());
        let legacy: AppConfig =
            serde_json::from_value(serde_json::to_value(AppConfig::default()).unwrap()).unwrap();
        assert!(legacy.exercise_media.is_empty());
        assert!(for_exercise(&AppConfig::default(), "Unknown lift").is_none());
        let config = config();
        MediaRegistry::new(&config).unwrap();
        let ExerciseMedia::Hosted {
            video_url,
            poster_url,
        } = for_exercise(&config, "Bench-press").unwrap()
        else {
            panic!("hosted override")
        };
        assert_eq!(
            video_url,
            format!("/v1/exercise-media/{}/video", "a".repeat(64))
        );
        assert_eq!(
            poster_url,
            format!("/v1/exercise-media/{}/poster", "b".repeat(64))
        );
        let mut bad = config.clone();
        bad.exercise_media.insert(
            "Bench press".into(),
            bad.exercise_media["benchpress"].clone(),
        );
        assert!(MediaRegistry::new(&bad).is_err());
        let mut bad = config;
        let ExerciseMediaConfig::Hosted { video_sha256, .. } =
            bad.exercise_media.get_mut("benchpress").unwrap()
        else {
            unreachable!()
        };
        *video_sha256 = "A".repeat(64);
        assert!(MediaRegistry::new(&bad).is_err());
    }

    #[test]
    fn bundled_aliases_are_exact_and_never_register_assets() {
        let config = AppConfig::default();
        for (names, id) in [
            (&["Bench press", "Barbell bench press"][..], "rT7DgCr-3pg"),
            (&["Leg press", "Seated leg press"][..], "IZxyjW7MPJQ"),
            (&["Lat pulldown", "Lat pulldowns"][..], "CAwf7n6Luuc"),
            (
                &["Barbell squat", "Barbell back squat", "Back squat"][..],
                "nFAscG0XUNY",
            ),
            (&["Plank", "Forearm plank"][..], "pSHjTRCQxIw"),
        ] {
            for name in names {
                assert_eq!(
                    for_exercise(&config, name),
                    Some(ExerciseMedia::Youtube {
                        video_id: id.into()
                    })
                );
            }
        }
        for name in ["Squat", "Bodyweight squat", "Row", "Press", "Unknown lift"] {
            assert!(for_exercise(&config, name).is_none(), "{name}");
        }
        assert!(MediaRegistry::new(&config).unwrap().assets.is_empty());
    }

    #[test]
    fn youtube_override_is_id_only_and_never_an_asset() {
        let mut config = config();
        config.exercise_media.insert(
            "benchpress".into(),
            ExerciseMediaConfig::Youtube {
                video_id: "Ab_12-xyZ09".into(),
            },
        );
        let registry = MediaRegistry::new(&config).unwrap();
        assert!(registry.assets.is_empty());
        assert_eq!(
            serde_json::to_value(for_exercise(&config, "Bench press").unwrap()).unwrap(),
            serde_json::json!({"type": "youtube", "video_id": "Ab_12-xyZ09"})
        );
        for id in [
            "",
            "short",
            "Ab_12-xyZ090",
            "Ab_12.xyZ09",
            "Ab_12/xyZ09",
            "é123456789",
        ] {
            config.exercise_media.insert(
                "benchpress".into(),
                ExerciseMediaConfig::Youtube {
                    video_id: id.into(),
                },
            );
            assert!(MediaRegistry::new(&config).is_err(), "{id}");
        }
        config.exercise_media.clear();
        config.exercise_media.insert(
            "Bench press".into(),
            ExerciseMediaConfig::Youtube {
                video_id: "Ab_12-xyZ09".into(),
            },
        );
        assert!(MediaRegistry::new(&config).is_err());
    }

    #[test]
    fn configuration_requires_explicit_provider_and_rejects_unknown_fields() {
        let hosted = serde_json::json!({
            "type": "hosted", "video_url": "https://example.com/a",
            "poster_url": "https://example.com/b", "video_sha256": "a".repeat(64),
            "poster_sha256": "b".repeat(64),
        });
        assert!(serde_json::from_value::<ExerciseMediaConfig>(hosted.clone()).is_ok());
        let mut untagged = hosted;
        untagged.as_object_mut().unwrap().remove("type");
        assert!(serde_json::from_value::<ExerciseMediaConfig>(untagged).is_err());
        assert!(
            serde_json::from_value::<ExerciseMediaConfig>(serde_json::json!({
                "type": "youtube", "video_id": "Ab_12-xyZ09", "video_url": "https://example.com/a"
            }))
            .is_err()
        );
    }

    #[test]
    fn unicode_media_keys_are_idempotent_and_resolve_case_expansions() {
        let mut config = config();
        let entry = config.exercise_media.remove("benchpress").unwrap();
        config.exercise_media.insert("ippress".into(), entry);
        MediaRegistry::new(&config).unwrap();
        for name in ["İP press", "i\u{307}p press", "IP-press", "ippress"] {
            let key = media_key(name);
            assert_eq!(key, "ippress", "{name}");
            assert_eq!(media_key(&key), key);
            assert!(for_exercise(&config, name).is_some(), "{name}");
        }
        let entry = config.exercise_media.remove("ippress").unwrap();
        config.exercise_media.insert("i\u{307}ppress".into(), entry);
        assert!(MediaRegistry::new(&config).is_err());
    }

    #[test]
    fn unsafe_urls_and_special_use_addresses_are_rejected() {
        for url in [
            "http://example.com/a",
            "https://example.com:8443/a",
            "https://user:pass@example.com/a",
            "https://@example.com/a",
            "https://example.com/a#fragment",
            "https://127.0.0.1/a",
            "https://2130706433/a",
            "https://169.254.169.254/a",
            "https://100.100.100.100/a",
            "https://[::1]/a",
            "https://[::ffff:127.0.0.1]/a",
            "https://localhost/a",
        ] {
            assert!(safe_url(url).is_err(), "{url}");
        }
        for ip in [
            "0.1.2.3",
            "10.1.2.3",
            "172.16.1.1",
            "192.168.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "::",
            "fc00::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "64:ff9b::7f00:1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()));
        }
    }

    #[test]
    fn only_pinned_bounded_supported_bytes_are_verified() {
        let mp4 = b"\0\0\0\x18ftypisom\0\0\0\0";
        assert_eq!(
            verify(mp4, &hash(mp4), Kind::Video, Some("video/mp4")).unwrap(),
            "video/mp4"
        );
        assert!(verify(mp4, &"0".repeat(64), Kind::Video, None).is_err());
        assert!(verify(mp4, &hash(mp4), Kind::Video, Some("text/html")).is_err());
        assert!(verify(b"<html>", &hash(b"<html>"), Kind::Video, None).is_err());
        let jpeg = b"\xff\xd8\xffposter";
        assert_eq!(
            verify(jpeg, &hash(jpeg), Kind::Poster, Some("image/jpeg")).unwrap(),
            "image/jpeg"
        );
        assert!(verify(b"<svg/>", &hash(b"<svg/>"), Kind::Poster, None).is_err());
        for kind in [Kind::Video, Kind::Poster] {
            let bytes = vec![0; kind.limit() + 1];
            assert!(verify(&bytes, &hash(&bytes), kind, None).is_err());
        }
    }

    #[tokio::test]
    async fn cache_reverifies_disk_and_unknown_routes_are_public_not_found() {
        let bytes = b"\xff\xd8\xffposter";
        let digest = hash(bytes);
        let mut config = config();
        let ExerciseMediaConfig::Hosted { poster_sha256, .. } =
            config.exercise_media.get_mut("benchpress").unwrap()
        else {
            unreachable!()
        };
        *poster_sha256 = digest.clone();
        let mut registry = MediaRegistry::new(&config).unwrap();
        let dir = tempfile::tempdir().unwrap();
        registry.cache_dir = dir.path().into();
        let asset = registry
            .assets
            .get(&(digest.clone(), Kind::Poster))
            .unwrap();
        tokio::fs::write(dir.path().join(format!("{digest}.poster")), bytes)
            .await
            .unwrap();
        assert_eq!(
            registry.bytes(asset).await.unwrap().0.as_slice(),
            bytes.as_slice()
        );
        let state = super::super::ApiState {
            pool: sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
            llm: chotu_common::ChotuLlm::new("http://127.0.0.1", 0, "unused"),
            tz: chrono_tz::Tz::UTC,
            config: Arc::new(config),
            memory: chotu_common::MemoryIndex::with_base_url("http://127.0.0.1:0", "unused"),
            media: Arc::new(registry),
        };
        let app = super::super::router(super::super::tests::test_auth(), state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = reqwest::get(format!(
            "http://{addr}/v1/exercise-media/{}/video",
            "c".repeat(64)
        ))
        .await
        .unwrap();
        assert_eq!(result.status(), StatusCode::NOT_FOUND);
        let url = format!("http://{addr}/v1/exercise-media/{digest}/poster");
        let client = reqwest::Client::new();
        let result = client
            .get(&url)
            .header("Authorization", "private-bogus-token")
            .header("X-Chotu-App-Version", "0.0.0")
            .send()
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(result.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(result.bytes().await.unwrap().as_ref(), bytes);
        let result = client.head(&url).send().await.unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(
            result.headers()[header::CONTENT_LENGTH].to_str().unwrap(),
            bytes.len().to_string()
        );
        assert!(result.bytes().await.unwrap().is_empty());
        let result = client
            .get(&url)
            .header(header::IF_NONE_MATCH, format!("\"{digest}\""))
            .send()
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::NOT_MODIFIED);
        let result = client
            .get(&url)
            .header(header::RANGE, "bytes=-3")
            .send()
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            result.bytes().await.unwrap().as_ref(),
            &bytes[bytes.len() - 3..]
        );
        server.abort();
    }

    #[tokio::test]
    async fn tampered_cache_is_removed_and_private_resolution_never_connects() {
        let mut registry = MediaRegistry::new(&AppConfig::default()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        registry.cache_dir = dir.path().into();
        let digest = hash(b"\xff\xd8\xffposter");
        // Test-only malformed asset bypasses startup URL checks to exercise
        // the independent DNS/IP check before the HTTP client is built.
        let asset = Asset {
            url: Url::parse("https://127.0.0.1/private").unwrap(),
            hash: digest.clone(),
            kind: Kind::Poster,
            fetch: Mutex::new(()),
        };
        let path = dir.path().join(format!("{digest}.poster"));
        tokio::fs::write(&path, b"tampered").await.unwrap();
        assert!(registry.bytes(&asset).await.is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn http_cache_and_single_range_semantics() {
        let bytes = b"0123456789".to_vec();
        let mut headers = HeaderMap::new();
        let response = media_response(bytes.clone(), "video/mp4", "abc", false, &headers);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::ETAG], "\"abc\"");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        for (range, expected) in [
            ("bytes=2-4", "bytes 2-4/10"),
            ("bytes=7-", "bytes 7-9/10"),
            ("bytes=-3", "bytes 7-9/10"),
            ("bytes=8-99", "bytes 8-9/10"),
        ] {
            headers.insert(header::RANGE, range.parse().unwrap());
            let response = media_response(bytes.clone(), "video/mp4", "abc", false, &headers);
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[header::CONTENT_RANGE], expected);
            let body = axum::body::to_bytes(response.into_body(), 10)
                .await
                .unwrap();
            assert_eq!(
                body.as_ref(),
                if range == "bytes=2-4" {
                    b"234".as_slice()
                } else if range == "bytes=8-99" {
                    b"89".as_slice()
                } else {
                    b"789".as_slice()
                }
            );
        }
        for range in [
            "bytes=10-",
            "bytes=3-1",
            "bytes=-0",
            "bytes=1-2,4-5",
            "items=1-2",
            "bytes=+1-2",
        ] {
            headers.insert(header::RANGE, range.parse().unwrap());
            let response = media_response(bytes.clone(), "video/mp4", "abc", false, &headers);
            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{range}"
            );
            assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        }
        headers.insert(header::RANGE, "bytes=1-2".parse().unwrap());
        headers.append(header::RANGE, "bytes=3-4".parse().unwrap());
        assert_eq!(
            media_response(bytes.clone(), "video/mp4", "abc", false, &headers).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        headers.insert(header::RANGE, "bytes=1-2".parse().unwrap());
        headers.insert(header::IF_RANGE, "\"other\"".parse().unwrap());
        assert_eq!(
            media_response(bytes.clone(), "video/mp4", "abc", false, &headers).status(),
            StatusCode::OK
        );
        headers.insert(header::IF_RANGE, "\"abc\"".parse().unwrap());
        assert_eq!(
            media_response(bytes.clone(), "video/mp4", "abc", false, &headers).status(),
            StatusCode::PARTIAL_CONTENT
        );
        let response = media_response(bytes.clone(), "video/mp4", "abc", true, &headers);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert!(axum::body::to_bytes(response.into_body(), 10)
            .await
            .unwrap()
            .is_empty());
        headers.insert(header::IF_NONE_MATCH, "W/\"abc\"".parse().unwrap());
        assert_eq!(
            media_response(bytes, "video/mp4", "abc", false, &headers).status(),
            StatusCode::NOT_MODIFIED
        );
    }
}
