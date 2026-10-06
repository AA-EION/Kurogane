//! `kurogane` — headless companion to the desktop app.
//!
//! Passwords are read from the terminal, or from `KUROGANE_PASSWORD` for
//! unattended use (CI, cron-driven sync on a headless box).

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use kurogane_core::db::{seed, Database};
use kurogane_core::kdf::KdfParams;
use kurogane_core::secure::Key256;
use kurogane_core::vault::{self, CreateOptions, UnlockedVault};
use kurogane_sync::engine::{select_transport, SyncEngine, SyncJob, TransportPreference};
use kurogane_sync::provision::Provisioner;
use kurogane_sync::rclone::{Provider, RemoteSection};
use kurogane_sync::sandbox::Sandbox;
use kurogane_sync::transport::{self, ContainerRuntime};
use zeroize::Zeroizing;

#[derive(Parser)]
#[command(name = "kurogane", version, about = "KUROGANE (黒鉄) headless vault & sync manager")]
struct Cli {
    /// Directory for the sync sandbox and working copies.
    #[arg(long, env = "KUROGANE_HOME", global = true)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Clone, Copy, ValueEnum)]
enum KdfProfile {
    Standard,
    Hardened,
}

#[derive(Clone, Copy, ValueEnum)]
enum TransportArg {
    Auto,
    Container,
    Binary,
}

#[derive(Clone, Copy, ValueEnum)]
enum LinkProvider {
    Drive,
    Onedrive,
    Mega,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a new vault and print its TOTP enrolment.
    Create {
        path: PathBuf,
        #[arg(long, default_value = "Infrastructure")]
        name: String,
        #[arg(long, default_value = "admin")]
        account: String,
        /// Pre-load the demo topology.
        #[arg(long)]
        demo: bool,
        #[arg(long, value_enum, default_value_t = KdfProfile::Standard)]
        kdf: KdfProfile,
    },
    /// Confirm TOTP enrolment with a code from your authenticator app.
    ConfirmTotp { path: PathBuf, code: String },
    /// Print the clear-text header (no password needed).
    Inspect { path: PathBuf },
    /// Unlock and print a topology summary.
    Unlock {
        path: PathBuf,
        #[arg(long)]
        totp: Option<String>,
        /// Print the full topology as JSON (never contains secrets).
        #[arg(long)]
        json: bool,
    },
    /// Emit the UI mock fixture: demo topology + demo secrets as JSON.
    DemoFixture {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Sync engine management.
    Engine {
        #[command(subcommand)]
        cmd: EngineCmd,
    },
    /// Link a cloud account (browser consent; no developer registration).
    Link {
        vault: PathBuf,
        #[arg(value_enum)]
        provider: LinkProvider,
        #[arg(long, default_value = "Kurogane/vault.kurogane")]
        remote_path: String,
        #[arg(long)]
        totp: Option<String>,
        /// MEGA account e-mail.
        #[arg(long)]
        user: Option<String>,
    },
    /// Run one sync round for every linked remote (or a local folder remote).
    Sync {
        vault: PathBuf,
        #[arg(long)]
        totp: Option<String>,
        #[arg(long, value_enum, default_value_t = TransportArg::Auto)]
        transport: TransportArg,
        /// Use an rclone `local` remote at this directory instead of linked clouds
        /// (testing, NAS shares). Does not require unlocking.
        #[arg(long)]
        local_remote: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum EngineCmd {
    /// Show container runtime and binary status.
    Status,
    /// Download + verify the pinned rclone binary into the sandbox.
    Provision,
}

fn home(cli_home: &Option<PathBuf>) -> Result<PathBuf> {
    if let Some(h) = cli_home {
        return Ok(h.clone());
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .context("cannot determine a data directory; pass --home")?;
    Ok(base.join("kurogane"))
}

fn password(prompt: &str) -> Result<Zeroizing<String>> {
    if let Ok(p) = std::env::var("KUROGANE_PASSWORD") {
        return Ok(Zeroizing::new(p));
    }
    Ok(Zeroizing::new(rpassword::prompt_password(prompt)?))
}

fn unlock(home: &Path, path: &Path, totp: Option<&str>) -> Result<UnlockedVault> {
    let header = vault::peek(path)?;
    let pw = password("Master password: ")?;
    let code = match (header.totp_required(), totp) {
        (true, None) => Some(Zeroizing::new(rpassword::prompt_password("TOTP code: ")?)),
        (_, c) => c.map(|c| Zeroizing::new(c.to_string())),
    };
    Ok(UnlockedVault::unlock(path, &home.join("work"), pw.as_bytes(), code.as_deref().map(|s| s.as_str()))?)
}

fn print_qr(data: &str) {
    if let Ok(code) = qrcode::QrCode::new(data.as_bytes()) {
        let s = code.render::<qrcode::render::unicode::Dense1x2>().quiet_zone(true).build();
        println!("{s}");
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = home(&cli.home)?;
    match cli.cmd {
        Cmd::Create { path, name, account, demo, kdf } => {
            let pw = password("New master password (≥12 chars): ")?;
            if std::env::var("KUROGANE_PASSWORD").is_err() && *pw != *password("Repeat: ")? {
                bail!("passwords do not match");
            }
            let kdf = match kdf {
                KdfProfile::Standard => KdfParams::STANDARD,
                KdfProfile::Hardened => KdfParams::HARDENED,
            };
            eprintln!("Deriving key (Argon2id, {} MiB, t={}, p={})…", kdf.m_cost_kib / 1024, kdf.t_cost, kdf.parallelism);
            let opts = CreateOptions { display_name: name, kdf, totp_account: account, seed_demo: demo };
            let (_v, enrol) = UnlockedVault::create(&path, &home.join("work"), pw.as_bytes(), &opts)?;
            println!("Created {}", path.display());
            println!("\nScan with your authenticator app, then run `kurogane confirm-totp {} <code>`:\n", path.display());
            print_qr(&enrol.otpauth_uri);
            println!("Secret: {}\nURI:    {}", enrol.secret_base32, enrol.otpauth_uri);
        }
        Cmd::ConfirmTotp { path, code } => {
            let pw = password("Master password: ")?;
            let mut v = UnlockedVault::unlock(&path, &home.join("work"), pw.as_bytes(), None)?;
            v.confirm_totp(&code)?;
            println!("TOTP enabled: future unlocks require a code.");
        }
        Cmd::Inspect { path } => {
            let h = vault::peek(&path)?;
            let out = serde_json::json!({
                "formatVersion": kurogane_core::container::FORMAT_VERSION,
                "kdf": h.kdf,
                "kdfMeetsFloor": h.kdf.meets_recommended_floor(),
                "flags": { "totpRequired": h.totp_required(), "raw": h.flags },
                "lineage": h.lineage(),
                "payloadBytes": h.payload_len,
            });
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        Cmd::Unlock { path, totp, json } => {
            let v = unlock(&home, &path, totp.as_deref())?;
            let t = v.topology()?;
            if json {
                println!("{}", serde_json::to_string_pretty(&t)?);
            } else {
                println!(
                    "{}: {} tenants, {} hosts, {} services, {} proxies ({} routes), {} credentials · keys mlocked: {}",
                    t.vault_name,
                    t.tenants.len(),
                    t.hosts.len(),
                    t.services.len(),
                    t.proxies.len(),
                    t.proxies.iter().map(|p| p.routes.len()).sum::<usize>(),
                    t.credentials.len(),
                    v.keys().all_memory_locked()
                );
            }
        }
        Cmd::DemoFixture { out } => {
            let db = Database::open_in_memory(&Key256::random())?;
            db.init_meta("00000000-0000-4000-8000-000000000000", "Demo Infrastructure")?;
            let field = Key256::random();
            let secrets = seed::seed_demo(&db, &field)?;
            let secrets: serde_json::Map<String, serde_json::Value> = secrets
                .into_iter()
                .map(|(id, (f, v))| (id, serde_json::json!({ "field": f, "value": v })))
                .collect();
            // Fixed, public demo TOTP seed so the browser mock can verify codes.
            let demo_seed = b"kurogane-demo-totp!!";
            let cfg = kurogane_core::totp::TotpConfig::default();
            let uri = kurogane_core::totp::otpauth_uri(demo_seed, &cfg, "Kurogane", "demo@kurogane.local");
            let json = serde_json::to_string_pretty(&serde_json::json!({
                "_comment": "Generated by `kurogane demo-fixture`. Demo data only; secrets and the TOTP seed are public test values.",
                "demoPassword": "kurogane-demo",
                "demoTotp": {
                    "secretBase32": kurogane_core::totp::secret_to_base32(demo_seed),
                    "otpauthUri": uri,
                    "qrSvg": kurogane_core::totp::qr_svg(&uri)?,
                },
                "topology": db.load_topology()?,
                "secrets": secrets,
            }))?;
            match out {
                Some(p) => std::fs::write(p, json + "\n")?,
                None => println!("{json}"),
            }
        }
        Cmd::Engine { cmd } => {
            let sb = Sandbox::open(home.join("sandbox"))?;
            match cmd {
                EngineCmd::Status => {
                    match ContainerRuntime::detect() {
                        Some(rt) => println!("container runtime: {:?} {} ({})", rt.flavor, rt.server_version, rt.binary.display()),
                        None => println!("container runtime: none (will use sandboxed binary)"),
                    }
                    let p = Provisioner::new(&sb)?;
                    match p.installed() {
                        Ok(Some(b)) => println!("rclone binary: {} (verified)", b.display()),
                        Ok(None) => println!("rclone binary: not provisioned"),
                        Err(e) => println!("rclone binary: INVALID ({e})"),
                    }
                    println!("image pin: {}", kurogane_sync::platform::RCLONE_IMAGE);
                }
                EngineCmd::Provision => {
                    let p = Provisioner::new(&sb)?;
                    let mut last = 0u64;
                    let bin = p.ensure(|done, total| {
                        if done - last > 4 * 1024 * 1024 {
                            last = done;
                            eprintln!("  {:.1} / {} MiB", done as f64 / 1048576.0, total.map(|t| format!("{:.1}", t as f64 / 1048576.0)).unwrap_or("?".into()));
                        }
                    })?;
                    println!("rclone ready: {}", bin.display());
                }
            }
        }
        Cmd::Link { vault: path, provider, remote_path, totp, user } => {
            let sb = Sandbox::open(home.join("sandbox"))?;
            let mut v = unlock(&home, &path, totp.as_deref())?;
            let bin = Provisioner::new(&sb)?.ensure(|_, _| {})?;
            let (prov, section) = match provider {
                LinkProvider::Mega => {
                    let user = user.context("--user is required for MEGA")?;
                    let pw = Zeroizing::new(rpassword::prompt_password("MEGA password: ")?);
                    (Provider::Mega, transport::mega_section(&bin, &sb, &user, &pw)?)
                }
                LinkProvider::Drive | LinkProvider::Onedrive => {
                    let prov = if matches!(provider, LinkProvider::Drive) { Provider::Drive } else { Provider::OneDrive };
                    let s = transport::authorize_oauth(&bin, &sb, prov, &mut |url| println!("Open this URL to grant access:\n  {url}"), Duration::from_secs(300))?;
                    (prov, s)
                }
            };
            let sync_key = &v.keys().sync;
            let id = v.db().upsert_sync_remote(sync_key, None, prov.rclone_type(), &format!("{prov:?}"), &remote_path, &section.to_body(), "auto")?;
            v.mark_dirty();
            v.save()?;
            println!("Linked {prov:?} as remote {id} → {remote_path}");
        }
        Cmd::Sync { vault: path, totp, transport: t, local_remote } => {
            let sb = Sandbox::open(home.join("sandbox"))?;
            let pref = match t {
                TransportArg::Auto => TransportPreference::Auto,
                TransportArg::Container => TransportPreference::Container,
                TransportArg::Binary => TransportPreference::Binary,
            };
            let transport = select_transport(&sb, pref, |_, _| {})?;
            eprintln!("transport: {:?}", transport.kind());
            let engine = SyncEngine::new(sb, transport);
            if let Some(dir) = local_remote {
                let dir = std::fs::canonicalize(&dir).with_context(|| format!("{} must exist", dir.display()))?;
                let section = RemoteSection::new(Provider::Local);
                let remote_path = format!("{}/{}", dir.display(), path.file_name().context("vault file name")?.to_string_lossy());
                let job = SyncJob { remote_id: &format!("local:{}", dir.display()), section: &section, remote_path: &remote_path, local_vault: &path };
                let report = engine.sync_once(&job, &|_| Ok(()))?;
                println!("{:?}: {}", report.decision, serde_json::to_string(&report.outcome)?);
                return Ok(());
            }
            let mut v = unlock(&home, &path, totp.as_deref())?;
            v.save_if_dirty()?;
            let remotes = v.db().sync_remotes()?;
            if remotes.is_empty() {
                bail!("no linked remotes; run `kurogane link` first");
            }
            for r in remotes {
                let section = RemoteSection::parse(&v.db().sync_remote_section(&v.keys().sync, &r.id)?)?;
                let job = SyncJob { remote_id: &r.id, section: &section, remote_path: &r.remote_path, local_vault: &path };
                let report = {
                    let validate = |b: &[u8]| v.validate_candidate(b).map(|_| ());
                    engine.sync_once(&job, &validate)?
                };
                println!("{} ({}): {:?} {}", r.label, r.remote_path, report.decision, serde_json::to_string(&report.outcome)?);
                if matches!(report.outcome, kurogane_sync::engine::SyncOutcome::Pulled { .. }) {
                    v.reload()?;
                }
                // After any reload, so a pulled database cannot drop fresh tokens.
                if let Some(fresh) = report.refreshed_section {
                    v.db().upsert_sync_remote(&v.keys().sync, Some(&r.id), &r.provider, &r.label, &r.remote_path, &fresh.to_body(), &r.transport)?;
                    v.mark_dirty();
                }
            }
            v.save_if_dirty()?;
        }
    }
    Ok(())
}
