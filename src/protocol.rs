use anyhow::{Result, bail, ensure};
use gix_packetline::{PacketLineRef, blocking_io::StreamingPeekableIter};
use std::io::{Read, Write};
use std::{cell::Cell, rc::Rc};
struct Counted<R> {
    inner: R,
    count: Rc<Cell<usize>>,
}
impl<R: Read> Read for Counted<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(bytes)?;
        self.count.set(self.count.get() + n);
        Ok(n)
    }
}
use zeroize::Zeroizing;
const LIMIT: usize = 64 * 1024 * 1024;
fn section<R: Read>(
    reader: &mut StreamingPeekableIter<R>,
    count: &Cell<usize>,
) -> Result<Option<Zeroizing<Vec<u8>>>> {
    let mut out = Zeroizing::new(Vec::new());
    loop {
        let before = count.get();
        match reader.read_line() {
            None if out.is_empty() && before == count.get() => return Ok(None),
            None => bail!("truncated filter request"),
            Some(Err(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof
                    && out.is_empty()
                    && before == count.get() =>
            {
                return Ok(None);
            }
            Some(line) => match line?? {
                PacketLineRef::Flush => return Ok(Some(out)),
                PacketLineRef::Data(data) => {
                    ensure!(
                        out.len() + data.len() <= LIMIT,
                        "filter input exceeds 64 MiB limit"
                    );
                    out.extend_from_slice(data);
                }
                _ => bail!("unexpected packet delimiter"),
            },
        }
    }
}
fn packet(w: &mut impl Write, bytes: &[u8]) -> Result<()> {
    for chunk in bytes.chunks(65516) {
        write!(w, "{:04x}", chunk.len() + 4)?;
        w.write_all(chunk)?;
    }
    Ok(())
}
fn flush(w: &mut impl Write) -> Result<()> {
    w.write_all(b"0000")?;
    w.flush()?;
    Ok(())
}
pub fn run<R: Read, W: Write>(
    r: R,
    mut w: W,
    mut transform: impl FnMut(&str, &str, &[u8]) -> Result<Zeroizing<Vec<u8>>>,
) -> Result<()> {
    let count = Rc::new(Cell::new(0));
    let mut r = StreamingPeekableIter::new(
        Counted {
            inner: r,
            count: count.clone(),
        },
        &[],
        false,
    );
    let hello = section(&mut r, &count)?.ok_or_else(|| anyhow::anyhow!("missing handshake"))?;
    ensure!(
        hello.as_slice() == b"git-filter-client\nversion=2\n",
        "unsupported filter handshake"
    );
    packet(&mut w, b"git-filter-server\n")?;
    packet(&mut w, b"version=2\n")?;
    flush(&mut w)?;
    let caps = section(&mut r, &count)?.ok_or_else(|| anyhow::anyhow!("missing capabilities"))?;
    for cap in ["capability=clean\n", "capability=smudge\n"] {
        if std::str::from_utf8(&caps)?
            .lines()
            .any(|l| l == cap.trim_end())
        {
            packet(&mut w, cap.as_bytes())?;
        }
    }
    flush(&mut w)?;
    while let Some(headers) = section(&mut r, &count)? {
        let headers = std::str::from_utf8(&headers)?;
        let command = headers
            .lines()
            .find_map(|s| s.strip_prefix("command="))
            .unwrap_or("");
        let path = headers
            .lines()
            .find_map(|s| s.strip_prefix("pathname="))
            .unwrap_or("");
        let input = section(&mut r, &count)?.ok_or_else(|| anyhow::anyhow!("missing content"))?;
        match transform(command, path, &input) {
            Ok(output) => {
                packet(&mut w, b"status=success\n")?;
                flush(&mut w)?;
                packet(&mut w, &output)?;
                flush(&mut w)?;
                flush(&mut w)?;
            }
            Err(_) => {
                eprintln!("bettergit: filter failed closed for {path}");
                packet(&mut w, b"status=error\n")?;
                flush(&mut w)?;
            }
        }
    }
    Ok(())
}
