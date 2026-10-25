//! Durable per-document storage: an append-only, checksummed log of updates.
//!
//! `data/docs/<doc_id>.log` holds records `[len: u32 LE][crc32: u32 LE][update bytes]`.
//! On open the log is replayed; a torn or corrupt tail is ignored and truncated away.
//! Compaction writes one `encode_full()` record to a temp file, fsyncs it, and renames it over
//! the log, so a crash at any point leaves either the old log or the new snapshot.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use weft_core::Update;

/// Records larger than this are treated as corruption.
const MAX_RECORD: usize = 256 << 20;
const HEADER: usize = 8;

#[derive(Clone, Debug)]
pub struct DocStore {
    dir: PathBuf,
    /// Compact once the log holds more than this many records...
    pub compact_records: usize,
    /// ...or has grown past this many bytes beyond twice the last snapshot.
    pub compact_bytes: u64,
}

impl DocStore {
    /// Uses `<data_dir>/docs`, creating it if needed.
    pub fn new(data_dir: &Path) -> io::Result<Self> {
        let dir = data_dir.join("docs");
        fs::create_dir_all(&dir)?;
        Ok(DocStore {
            dir,
            compact_records: 1000,
            compact_bytes: 1 << 20,
        })
    }

    pub fn path(&self, doc_id: &str) -> PathBuf {
        self.dir.join(format!("{doc_id}.log"))
    }

    pub fn exists(&self, doc_id: &str) -> bool {
        self.path(doc_id).exists()
    }

    /// Replays the log (creating it if missing). Returns the valid records and an appender.
    pub fn open(&self, doc_id: &str) -> io::Result<(Vec<Update>, DocLog)> {
        let path = self.path(doc_id);
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&path)?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        let (records, valid) = parse_records(&buf);
        if valid < buf.len() {
            tracing::warn!(
                doc_id,
                dropped_bytes = buf.len() - valid,
                "truncating torn/corrupt log tail"
            );
            file.set_len(valid as u64)?;
            file.sync_all()?;
        }
        let log = DocLog {
            path,
            file,
            records: records.len(),
            bytes: valid as u64,
            snapshot_bytes: 0,
            compact_records: self.compact_records,
            compact_bytes: self.compact_bytes,
        };
        Ok((records, log))
    }

    /// Reads the records without keeping the file open or repairing it.
    pub fn read(&self, doc_id: &str) -> io::Result<Vec<Update>> {
        let buf = fs::read(self.path(doc_id))?;
        Ok(parse_records(&buf).0)
    }
}

/// Parses records up to the first torn/corrupt one. Returns them and the valid byte length.
fn parse_records(buf: &[u8]) -> (Vec<Update>, usize) {
    let mut out = Vec::new();
    let mut off = 0;
    while buf.len() - off >= HEADER {
        let len = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
        let crc = u32::from_le_bytes(buf[off + 4..off + 8].try_into().unwrap());
        if len > MAX_RECORD || buf.len() - off - HEADER < len {
            break;
        }
        let body = &buf[off + HEADER..off + HEADER + len];
        if crc32fast::hash(body) != crc {
            break;
        }
        out.push(Update(body.to_vec()));
        off += HEADER + len;
    }
    (out, off)
}

fn record(update: &Update) -> Vec<u8> {
    let mut rec = Vec::with_capacity(HEADER + update.0.len());
    rec.extend_from_slice(&(update.0.len() as u32).to_le_bytes());
    rec.extend_from_slice(&crc32fast::hash(&update.0).to_le_bytes());
    rec.extend_from_slice(&update.0);
    rec
}

/// An open, append-only document log.
pub struct DocLog {
    path: PathBuf,
    file: File,
    records: usize,
    bytes: u64,
    snapshot_bytes: u64,
    compact_records: usize,
    compact_bytes: u64,
}

impl DocLog {
    /// Appends one record with a single `write` (reaches the kernel, so it survives a process
    /// crash; not fsynced per keystroke).
    pub fn append(&mut self, update: &Update) -> io::Result<()> {
        let rec = record(update);
        self.file.write_all(&rec)?;
        self.records += 1;
        self.bytes += rec.len() as u64;
        Ok(())
    }

    pub fn needs_compaction(&self) -> bool {
        self.records > 1
            && (self.records > self.compact_records
                || self.bytes > 2 * self.snapshot_bytes + self.compact_bytes)
    }

    /// Replaces the log with a single snapshot record: temp file, fsync, rename, fsync dir.
    pub fn compact(&mut self, full: &Update) -> io::Result<()> {
        let tmp = self.path.with_extension("log.tmp");
        let rec = record(full);
        {
            let mut f = File::create(&tmp)?;
            f.write_all(&rec)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        if let Some(dir) = self.path.parent()
            && let Ok(d) = File::open(dir)
        {
            let _ = d.sync_all();
        }
        self.file = OpenOptions::new().append(true).open(&self.path)?;
        self.records = 1;
        self.bytes = rec.len() as u64;
        self.snapshot_bytes = self.bytes;
        Ok(())
    }

    /// fsyncs the log (used when a room unloads).
    pub fn sync(&self) -> io::Result<()> {
        self.file.sync_data()
    }
}
