use super::{Index, cache, git};
use anyhow::Result;
use bettergit::{config::Policy, crypto, engine};
use serde::Serialize;
use std::{
    io::{self, Write},
    process::Command,
};
use zeroize::Zeroizing;

#[derive(Serialize)]
struct Issue<'a> {
    path: &'a str,
    code: &'static str,
}

#[derive(Serialize)]
struct Report<'a> {
    version: u8,
    checked: usize,
    issues: Vec<Issue<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

struct Entry<'a> {
    mode: &'a str,
    oid: &'a str,
    stage: &'a str,
    path: &'a str,
}

impl<'a> Entry<'a> {
    fn parse(record: &'a str) -> Option<Self> {
        let (metadata, path) = record.split_once('\t')?;
        let (mode, rest) = metadata.split_once(' ')?;
        let (oid, stage) = rest.split_once(' ')?;
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        Some(Self {
            mode,
            oid,
            stage,
            path,
        })
    }

    fn regular(&self) -> bool {
        matches!(self.mode, "100644" | "100755")
    }
}

fn local_git() -> Command {
    let mut command = Command::new("git");
    command
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
    command
}

fn snapshot() -> Result<String, &'static str> {
    let root = git(&["rev-parse", "--show-toplevel"]).map_err(|_| "not_worktree")?;
    let index = git(&["rev-parse", "--path-format=absolute", "--git-path", "index"])
        .map_err(|_| "index_unavailable")?;
    let output = local_git()
        .current_dir(root)
        .env("GIT_INDEX_FILE", index)
        .args(["ls-files", "--stage", "-z"])
        .output()
        .map_err(|_| "index_unavailable")?;
    if !output.status.success() {
        return Err("index_unavailable");
    }
    String::from_utf8(output.stdout).map_err(|_| "index_not_utf8")
}

fn scan(snapshot: &str) -> Result<Report<'_>, &'static str> {
    let entries: Vec<_> = snapshot
        .split_terminator('\0')
        .map(Entry::parse)
        .collect::<Option<_>>()
        .ok_or("invalid_index")?;
    if entries.iter().any(|entry| entry.stage != "0") {
        return Err("unmerged_index");
    }
    let policy_entry = entries
        .iter()
        .find(|entry| entry.path == ".access.yml")
        .ok_or("missing_policy")?;
    if !policy_entry.regular() {
        return Err("invalid_policy");
    }
    let mut index = Index::start(local_git()).map_err(|_| "blob_reader_unavailable")?;
    let policy_bytes = index
        .request_blob(format_args!("{}", policy_entry.oid))
        .map_err(|_| "policy_blob_unavailable")?
        .ok_or("policy_blob_unavailable")?;
    let policy = std::str::from_utf8(&policy_bytes)
        .ok()
        .and_then(|text| Policy::parse(text).ok())
        .ok_or("invalid_policy")?;
    let pinned = cache().map_err(|_| "pin_unavailable")?.join("policy.yml");
    match std::fs::read_to_string(pinned) {
        Ok(data) => {
            let pin = Policy::parse(&data).map_err(|_| "invalid_pin")?;
            if pin.config != policy.config {
                return Err("policy_mismatch");
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("pin_unavailable"),
    }

    let mut report = Report {
        version: 1,
        checked: 0,
        issues: Vec::new(),
        error: None,
    };
    for entry in entries {
        let rule = match policy.rule(entry.path) {
            Ok(Some(rule)) => rule,
            Ok(None) => continue,
            Err(_) => {
                report.issues.push(Issue {
                    path: entry.path,
                    code: "path_policy_error",
                });
                continue;
            }
        };
        report.checked += 1;
        let mode = rule.mode_for(entry.path);
        let issue = if !entry.regular() {
            Some("unsupported_entry")
        } else if engine::require_env(entry.path, mode).is_err() {
            Some("unsupported_value_format")
        } else if let Some(key) = &rule.signing_key {
            let signer = crypto::parse_signer(key).map_err(|_| "invalid_policy")?;
            let blob = Zeroizing::new(
                index
                    .request_blob(format_args!("{}", entry.oid))
                    .map_err(|_| "blob_unavailable")?
                    .ok_or("blob_unavailable")?,
            );
            engine::validate_at(entry.path, &blob, mode, Some(&signer))
                .is_err()
                .then_some("invalid_ciphertext")
        } else {
            Some("missing_signer")
        };
        if let Some(code) = issue {
            report.issues.push(Issue {
                path: entry.path,
                code,
            });
        }
    }
    Ok(report)
}

pub(super) fn run(json: bool) -> Result<i32> {
    let snapshot = snapshot();
    let report = match snapshot.as_deref().map_err(|&code| code).and_then(scan) {
        Ok(report) => report,
        Err(error) => Report {
            version: 1,
            checked: 0,
            issues: Vec::new(),
            error: Some(error),
        },
    };
    let code = if report.error.is_some() {
        2
    } else {
        i32::from(!report.issues.is_empty())
    };
    let mut output = io::stdout().lock();
    if json {
        serde_json::to_writer(&mut output, &report)?;
        writeln!(output)?;
    } else if let Some(error) = report.error {
        writeln!(io::stderr().lock(), "bettergit check-staged: {error}")?;
    } else {
        for issue in &report.issues {
            writeln!(output, "{:?}: {}", issue.path, issue.code)?;
        }
        writeln!(
            output,
            "{} protected paths, {} issues",
            report.checked,
            report.issues.len()
        )?;
    }
    output.flush()?;
    Ok(code)
}
