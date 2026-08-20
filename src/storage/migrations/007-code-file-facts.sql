-- Two facts about a file the index had no column for, and one index no query
-- ever read.
--
-- `ctime` closes the staleness hole left by (mtime, size): every tool that
-- restores content while preserving mtime — `cp -p`, `tar -x`, `rsync -t`, a CI
-- cache restore — can land new bytes under the recorded mtime at an identical
-- byte count, after which the index serves symbols that no longer exist and
-- doctor calls it in sync. No userspace call can set an inode's change time, so
-- it is the one half of the pair a restore cannot forge.
--
-- `has_error` records that the grammar could not read the file end to end. The
-- symbols of such a file are a prefix, not an inventory, so "the symbol is
-- absent from this file" must not be asserted about it.
--
-- Both default to the value that reads as "not known yet"; the extraction
-- version bump that ships with them forces the full rebuild that fills them in.
ALTER TABLE files ADD COLUMN ctime INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN has_error INTEGER NOT NULL DEFAULT 0;

-- Dropped for want of a reader: symbol suggestions match with a leading
-- wildcard, which SQLite cannot serve from an index, and every exact lookup
-- goes through the in-process symbol table. What is left is insert cost.
DROP INDEX idx_symbols_name;
