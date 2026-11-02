use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy, Serialize)]
pub struct Retention {
    pub recovery_keep_last: usize,
    pub snapshot_keep_last: usize,
}
impl Retention {
    pub fn from_env() -> anyhow::Result<Self> {
        fn count(name: &str, default: usize) -> anyhow::Result<usize> {
            match std::env::var(name) {
                Ok(value) => value
                    .parse()
                    .map_err(|_| anyhow::anyhow!("{name} must be a nonnegative integer")),
                Err(std::env::VarError::NotPresent) => Ok(default),
                Err(e) => Err(e.into()),
            }
        }
        Ok(Self {
            recovery_keep_last: count("BACKUP_KEEP_LAST", 7)?,
            snapshot_keep_last: count("OMNI_SNAPSHOT_KEEP_LAST", 30)?,
        })
    }
}

pub fn recovery_name(name: &str) -> bool {
    name.starts_with("companion-")
        && name.ends_with(".tcb")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.'))
}

/// Only complete, regular recovery files qualify; always protect the file just committed.
pub fn recovery_files(dir: &Path, keep: usize, current: &str) -> anyhow::Result<usize> {
    if keep == 0 {
        return Ok(0);
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if recovery_name(&name) && entry.file_type()?.is_file() {
            files.push((name, entry.metadata()?.modified()?));
        }
    }
    files.sort_by(|(a, at), (b, bt)| {
        (b == current)
            .cmp(&(a == current))
            .then_with(|| bt.cmp(at))
            .then_with(|| b.cmp(a))
    });
    let mut removed = 0;
    for (name, _) in files.into_iter().skip(keep) {
        std::fs::remove_file(dir.join(name))?;
        removed += 1;
    }
    Ok(removed)
}

/// Omni uses <cluster-uuid>/<16-hex reverse UNIX timestamp>.snapshot.
/// Unknown objects, symlinks, and multipart staging files are never candidates.
pub fn snapshot_paths(root: &Path, keep: usize) -> anyhow::Result<Vec<std::path::PathBuf>> {
    if keep == 0 || !root.join("omni").is_dir() {
        return Ok(Vec::new());
    }
    let mut clusters = BTreeMap::new();
    for entry in std::fs::read_dir(root.join("omni"))? {
        let entry = entry?;
        let cluster = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir() || uuid::Uuid::parse_str(&cluster).is_err() {
            continue;
        }
        let mut snapshots = Vec::new();
        for entry in std::fs::read_dir(entry.path())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(hex) = name
                .strip_suffix(".snapshot")
                .filter(|s| s.len() == 16 && s.bytes().all(|c| c.is_ascii_hexdigit()))
            else {
                continue;
            };
            if !entry.file_type()?.is_file() {
                continue;
            }
            let timestamp = u64::from_str_radix(hex, 16)?.wrapping_neg();
            // Do not classify a foreign/invalid filename as an Omni snapshot.
            if timestamp == 0 || timestamp > crate::model::now().saturating_add(300) {
                continue;
            }
            snapshots.push((timestamp, name));
        }
        snapshots.sort_by(|a, b| b.cmp(a));
        clusters.insert(cluster, snapshots);
    }
    let mut paths = Vec::new();
    for (cluster, snapshots) in clusters {
        for (_, name) in snapshots.into_iter().skip(keep) {
            let key = format!("{cluster}/{name}");
            paths.push(root.join("omni").join(&key));
            let prefix = format!(
                ".bucket-{}.object-{}",
                URL_SAFE_NO_PAD.encode("omni"),
                URL_SAFE_NO_PAD.encode(&key)
            );
            for suffix in [".metadata.json", ".internal.json"] {
                paths.push(root.join(format!("{prefix}{suffix}")));
            }
        }
    }
    Ok(paths)
}

/// Called under the same exclusive source lock as snapshot creation, after its durable commit.
pub fn received_snapshots(root: &Path, keep: usize) -> anyhow::Result<usize> {
    let paths = snapshot_paths(root, keep)?;
    let mut removed = 0;
    for path in paths {
        match std::fs::remove_file(&path) {
            Ok(()) => {
                if path.extension().is_some_and(|e| e == "snapshot") {
                    removed += 1;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_newest_per_cluster_and_leaves_foreign_and_multipart_files() {
        let root = tempfile::tempdir().unwrap();
        for cluster in [uuid::Uuid::new_v4(), uuid::Uuid::new_v4()] {
            let dir = root.path().join("omni").join(cluster.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            for seconds in [100u64, 200, 300] {
                let name = format!("{:016X}.snapshot", seconds.wrapping_neg());
                std::fs::write(dir.join(&name), b"snapshot").unwrap();
                let prefix = format!(
                    ".bucket-{}.object-{}",
                    URL_SAFE_NO_PAD.encode("omni"),
                    URL_SAFE_NO_PAD.encode(format!("{cluster}/{name}"))
                );
                std::fs::write(root.path().join(format!("{prefix}.metadata.json")), b"{}").unwrap();
            }
            std::fs::write(dir.join("manual.snapshot"), b"foreign file").unwrap();
        }
        std::fs::write(
            root.path().join(".upload_id-example.part-1"),
            b"pending upload",
        )
        .unwrap();
        assert_eq!(received_snapshots(root.path(), 2).unwrap(), 2);
        assert_eq!(received_snapshots(root.path(), 2).unwrap(), 0);
        assert_eq!(received_snapshots(root.path(), 0).unwrap(), 0);
        assert!(root.path().join(".upload_id-example.part-1").exists());
        assert_eq!(
            std::fs::read_dir(root.path())
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".metadata.json"))
                .count(),
            4
        );
        for cluster in std::fs::read_dir(root.path().join("omni")).unwrap() {
            let dir = cluster.unwrap().path();
            assert!(dir.join("manual.snapshot").exists());
            assert!(
                !dir.join(format!("{:016X}.snapshot", 100u64.wrapping_neg()))
                    .exists()
            );
        }
    }
    #[test]
    fn recovery_retention_protects_current_and_ignores_other_files() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "companion-100-a.tcb",
            "companion-200-b.tcb",
            "companion-300-c.tcb",
            "other.txt",
            ".partial",
        ] {
            std::fs::write(dir.path().join(name), b"file").unwrap();
        }
        assert_eq!(
            recovery_files(dir.path(), 1, "companion-100-a.tcb").unwrap(),
            2
        );
        assert!(dir.path().join("companion-100-a.tcb").exists());
        assert!(dir.path().join("other.txt").exists());
        assert!(dir.path().join(".partial").exists());
    }
}
