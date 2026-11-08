use crate::{auth, model::*, retention::Retention};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub retention: Retention,
    pub schedule: Schedule,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub destination: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            retention: Retention {
                recovery_keep_last: 7,
                snapshot_keep_last: 30,
            },
            schedule: Schedule {
                enabled: true,
                interval_seconds: 86400,
                destination: "local".into(),
            },
        }
    }
}
impl Settings {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            (60..=31_536_000).contains(&self.schedule.interval_seconds),
            "Schedule interval must be between 60 seconds and one year"
        );
        anyhow::ensure!(
            matches!(
                self.schedule.destination.as_str(),
                "local" | "mounted" | "drive" | "network"
            ),
            "Unknown scheduled destination"
        );
        anyhow::ensure!(
            self.retention.recovery_keep_last <= 1_000_000
                && self.retention.snapshot_keep_last <= 1_000_000,
            "Retention counts must be between 0 and 1,000,000"
        );
        Ok(())
    }
    pub fn load(data: &Path) -> anyhow::Result<Self> {
        let settings: Self = match std::fs::read(data.join("config.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let settings = Self::default();
                settings.persist(data)?;
                settings
            }
            Err(e) => return Err(e.into()),
        };
        settings.validate()?;
        Ok(settings)
    }
    pub fn persist(&self, data: &Path) -> anyhow::Result<()> {
        self.validate()?;
        let mut tmp = tempfile::NamedTempFile::new_in(data)?;
        tmp.write_all(&serde_json::to_vec_pretty(self)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(data.join("config.json"))?;
        Ok(())
    }
}
pub async fn get(State(app): State<App>, headers: HeaderMap) -> Result<Json<Settings>> {
    auth::admin(&app, &headers).await?;
    Ok(Json(app.settings.borrow().clone()))
}
pub async fn update(
    State(app): State<App>,
    headers: HeaderMap,
    Json(settings): Json<Settings>,
) -> Result<Json<Settings>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    settings.validate().map_err(|e| bad(&e.to_string()))?;
    if settings.schedule.enabled {
        if settings.schedule.destination == "network"
            && app
                .store
                .read()
                .await
                .as_ref()
                .is_none_or(|s| s.network.is_none())
        {
            return Err(bad("Connect a network share before scheduling it"));
        }
        if settings.schedule.destination == "mounted" && app.mounted.is_none() {
            return Err(bad("Configure a mounted destination before scheduling it"));
        }
        if settings.schedule.destination == "drive"
            && app
                .store
                .read()
                .await
                .as_ref()
                .is_none_or(|s| s.drive.refresh_token.is_empty())
        {
            return Err(bad("Connect Google Drive before scheduling it"));
        }
    }
    let _serial = app.backup_lock.lock().await;
    settings.persist(&app.data)?;
    app.settings.send_replace(settings.clone());
    Ok(Json(settings))
}
async fn next_schedule(changes: &mut tokio::sync::watch::Receiver<Settings>) -> Schedule {
    loop {
        let settings = changes.borrow_and_update().clone();
        let elapsed = async {
            if settings.schedule.enabled {
                tokio::time::sleep(std::time::Duration::from_secs(
                    settings.schedule.interval_seconds,
                ))
                .await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            biased;
            _ = changes.changed() => continue,
            _ = elapsed => return settings.schedule,
        }
    }
}
pub async fn run(app: &App) {
    let mut changes = app.settings.subscribe();
    loop {
        let schedule = next_schedule(&mut changes).await;
        if app.store.read().await.is_some()
            && let Err(e) = crate::backup::create(app, &schedule.destination).await
        {
            tracing::error!(message=%e.1, "scheduled backup failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn schedule_changes_reset_timer_and_disabled_schedule_waits() {
        use tokio::time::{Duration, advance};
        let (sender, mut receiver) = tokio::sync::watch::channel(Settings::default());
        let task = tokio::spawn(async move { next_schedule(&mut receiver).await });
        tokio::task::yield_now().await;
        advance(Duration::from_secs(100)).await;
        let mut settings = Settings::default();
        settings.schedule.enabled = false;
        sender.send_replace(settings.clone());
        tokio::task::yield_now().await;
        advance(Duration::from_secs(100_000)).await;
        assert!(!task.is_finished());
        settings.schedule.enabled = true;
        settings.schedule.interval_seconds = 60;
        settings.schedule.destination = "mounted".into();
        sender.send_replace(settings);
        tokio::task::yield_now().await;
        advance(Duration::from_secs(59)).await;
        assert!(!task.is_finished());
        advance(Duration::from_secs(1)).await;
        assert_eq!(task.await.unwrap().destination, "mounted");
    }
    #[test]
    fn config_roundtrip_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::load(dir.path()).unwrap();
        settings.schedule.enabled = false;
        settings.retention.snapshot_keep_last = 0;
        settings.persist(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), settings);
        settings.schedule.interval_seconds = 0;
        assert!(settings.persist(dir.path()).is_err());
        assert!(!Settings::load(dir.path()).unwrap().schedule.enabled);
        std::fs::write(dir.path().join("config.json"), b"{}").unwrap();
        assert!(Settings::load(dir.path()).is_err());
    }
}
