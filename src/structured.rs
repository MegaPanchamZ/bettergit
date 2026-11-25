use anyhow::{Context, Result, bail, ensure};
use yaml_edit::{YamlFile, YamlNode};
use zeroize::Zeroizing;
fn ranges(node: YamlNode, context: &str, out: &mut Vec<(usize, usize, String)>) -> Result<()> {
    match node {
        YamlNode::Scalar(s) => {
            let r = s.byte_range();
            out.push((r.start as usize, r.end as usize, context.to_owned()));
        }
        YamlNode::Mapping(m) => {
            for entry in m.entries() {
                let key = entry.key_node().context("missing mapping key")?;
                ensure!(key.is_scalar(), "complex mapping keys unsupported");
                let key = key.as_scalar().unwrap().as_string();
                let next = format!("{context}/{}", key.replace('~', "~0").replace('/', "~1"));
                ranges(
                    entry.value_node().context("explicit values required")?,
                    &next,
                    out,
                )?;
            }
        }
        YamlNode::Sequence(s) => {
            for (i, item) in s.values().enumerate() {
                ranges(item, &format!("{context}/{i}"), out)?;
            }
        }
        _ => bail!("YAML aliases and tags are unsupported"),
    }
    Ok(())
}
pub fn map(
    input: &[u8],
    mut f: impl FnMut(&str, &str) -> Result<String>,
) -> Result<Zeroizing<Vec<u8>>> {
    let text = std::str::from_utf8(input)?;
    let parsed = YamlFile::parse(text);
    ensure!(!parsed.has_errors(), "invalid structured input");
    let tree = parsed.tree();
    let mut spans = Vec::new();
    for (i, doc) in tree.documents().enumerate() {
        let context = format!("document:{i}");
        if let Some(m) = doc.as_mapping() {
            ranges(YamlNode::Mapping(m), &context, &mut spans)?;
        } else if let Some(s) = doc.as_sequence() {
            ranges(YamlNode::Sequence(s), &context, &mut spans)?;
        } else if let Some(s) = doc.as_scalar() {
            ranges(YamlNode::Scalar(s), &context, &mut spans)?;
        } else {
            bail!("unsupported document");
        }
    }
    spans.sort_unstable();
    let mut out = Zeroizing::new(String::new());
    let mut cursor = 0;
    for (start, mut end, context) in spans {
        // A block scalar span includes its final line ending. Keep that separator
        // outside the encrypted token so the next mapping entry remains valid YAML.
        while end > start && matches!(text.as_bytes()[end - 1], b'\r' | b'\n') {
            end -= 1;
        }
        ensure!(start >= cursor && end <= text.len(), "invalid scalar span");
        out.push_str(&text[cursor..start]);
        if start != end {
            out.push_str(&f(&context, &text[start..end])?);
        }
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    Ok(Zeroizing::new(out.as_bytes().to_vec()))
}
