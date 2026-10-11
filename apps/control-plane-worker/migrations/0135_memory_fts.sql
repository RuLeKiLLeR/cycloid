CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
  claim,
  content='memory_facts',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(rowid, claim) VALUES (new.rowid, new.claim);
END;

CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, claim) VALUES('delete', old.rowid, old.claim);
END;

CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, claim) VALUES('delete', old.rowid, old.claim);
  INSERT INTO memory_facts_fts(rowid, claim) VALUES (new.rowid, new.claim);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_takes_fts USING fts5(
  claim,
  content='memory_takes',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_takes_ai AFTER INSERT ON memory_takes BEGIN
  INSERT INTO memory_takes_fts(rowid, claim) VALUES (new.rowid, new.claim);
END;

CREATE TRIGGER IF NOT EXISTS memory_takes_ad AFTER DELETE ON memory_takes BEGIN
  INSERT INTO memory_takes_fts(memory_takes_fts, rowid, claim) VALUES('delete', old.rowid, old.claim);
END;

CREATE TRIGGER IF NOT EXISTS memory_takes_au AFTER UPDATE ON memory_takes BEGIN
  INSERT INTO memory_takes_fts(memory_takes_fts, rowid, claim) VALUES('delete', old.rowid, old.claim);
  INSERT INTO memory_takes_fts(rowid, claim) VALUES (new.rowid, new.claim);
END;

INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild');

INSERT INTO memory_takes_fts(memory_takes_fts) VALUES('rebuild');
