use anyhow::{Result, ensure};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use std::path::{Component, Path};

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub org: String,
    pub rules: Vec<Rule>,
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub path: String,
    pub mode: Mode,
    pub allow: Vec<String>,
    pub stub: Option<String>,
    pub signing_key: Option<String>,
}
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Value,
    File,
    #[serde(skip)]
    Json,
    #[serde(skip)]
    Yaml,
}
pub struct Policy {
    pub config: Config,
    globs: GlobSet,
}
pub fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
        && !path.contains(['\n', '\r', '\\'])
}
impl Rule {
    pub fn mode_for(&self, path: &str) -> Mode {
        if self.mode != Mode::Value {
            return self.mode;
        }
        if path.ends_with(".json") {
            Mode::Json
        } else if path.ends_with(".yaml") || path.ends_with(".yml") {
            Mode::Yaml
        } else {
            Mode::Value
        }
    }
    pub fn group(&self) -> &str {
        &self.allow[0]
    }
}
impl Policy {
    pub fn load(root: &Path) -> Result<Self> {
        Self::parse(&std::fs::read_to_string(root.join(".access.yml"))?)
    }
    pub fn parse(text: &str) -> Result<Self> {
        let config: Config = serde_saphyr::from_str(text)?;
        ensure!(
            config.version == 1 && !config.org.is_empty(),
            "unsupported or invalid policy"
        );
        let mut builder = GlobSetBuilder::new();
        for rule in &config.rules {
            ensure!(
                safe_path(&rule.path)
                    && !rule
                        .path
                        .contains([' ', '\t', '"', '{', '}', '(', ')', '[', ']']),
                "invalid rule path"
            );
            ensure!(
                rule.allow.len() == 1 && !rule.allow[0].is_empty(),
                "V1 requires exactly one access group per rule"
            );
            ensure!(
                rule.stub.as_deref().is_none_or(safe_path),
                "invalid stub path"
            );
            if let Some(key) = &rule.signing_key {
                crate::crypto::parse_signer(key)?;
            }
            ensure!(
                !rule.path.starts_with(['#', '!'])
                    && !rule.path.starts_with("[attr]")
                    && !rule.path.starts_with(".git/"),
                "reserved attribute path"
            );
            let pattern = if rule.path.contains('/') {
                rule.path.clone()
            } else {
                format!("**/{}", rule.path)
            };
            builder.add(GlobBuilder::new(&pattern).literal_separator(true).build()?);
        }
        let globs = builder.build()?;
        for reserved in [".access.yml", ".gitattributes", ".git/config"] {
            ensure!(
                !globs.is_match(reserved),
                "policy cannot protect its own configuration or Git metadata"
            );
        }
        Ok(Self { config, globs })
    }
    pub fn rule(&self, path: &str) -> Result<Option<&Rule>> {
        ensure!(safe_path(path), "unsafe Git path");
        let matches = self.globs.matches(path);
        ensure!(matches.len() <= 1, "overlapping access rules for {path}");
        Ok(matches.first().map(|i| &self.config.rules[*i]))
    }
}
