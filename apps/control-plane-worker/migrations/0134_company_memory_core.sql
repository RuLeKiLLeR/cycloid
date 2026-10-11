CREATE TABLE IF NOT EXISTS memory_pages (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL,
  page_type       TEXT NOT NULL CHECK(page_type IN ('customer','repo','service','person','channel','incident','thread','decision','episode')),
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT,
  effective_at_ms INTEGER,
  created_at_ms   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at_ms   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at_ms   INTEGER,
  UNIQUE (business_id, page_type, slug)
);

CREATE INDEX IF NOT EXISTS idx_memory_pages_business_type
  ON memory_pages(business_id, page_type, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS memory_facts (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL,
  kind              TEXT NOT NULL
    CHECK(kind IN ('decision','constraint','action_item','open_question','preference','fact','dead_end','commitment')),
  claim             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','expired','superseded','rejected')),
  holder            TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
  effective_at_ms   INTEGER,
  valid_until_ms    INTEGER,
  due_at_ms         INTEGER,
  superseded_by     TEXT,
  source_event_id   TEXT NOT NULL,
  created_at_ms     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expired_at_ms     INTEGER,
  FOREIGN KEY (source_event_id) REFERENCES ingestion_events(id),
  FOREIGN KEY (superseded_by) REFERENCES memory_facts(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_business_kind_status
  ON memory_facts(business_id, kind, status, effective_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_facts_business_holder
  ON memory_facts(business_id, holder, status);
CREATE INDEX IF NOT EXISTS idx_memory_facts_business_event
  ON memory_facts(business_id, source_event_id);

CREATE TABLE IF NOT EXISTS memory_takes (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL,
  page_id           TEXT,
  kind              TEXT NOT NULL CHECK(kind IN ('fact','take','bet','hunch')),
  claim             TEXT NOT NULL,
  holder            TEXT NOT NULL,
  weight            REAL NOT NULL DEFAULT 0.5 CHECK(weight BETWEEN 0 AND 1),
  since_ms          INTEGER,
  until_ms          INTEGER,
  superseded_by     TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  hitl_approved     INTEGER NOT NULL DEFAULT 0,
  created_at_ms     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (page_id) REFERENCES memory_pages(id),
  FOREIGN KEY (superseded_by) REFERENCES memory_takes(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_takes_business_page_active
  ON memory_takes(business_id, page_id, active, weight DESC);

CREATE TABLE IF NOT EXISTS memory_links (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL,
  from_page_id      TEXT NOT NULL,
  to_page_id        TEXT NOT NULL,
  link_type         TEXT NOT NULL,
  link_source       TEXT NOT NULL CHECK(link_source IN ('extracted','manual','derived')),
  origin_event_id   TEXT NOT NULL,
  context           TEXT,
  created_at_ms     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (from_page_id) REFERENCES memory_pages(id),
  FOREIGN KEY (to_page_id) REFERENCES memory_pages(id),
  FOREIGN KEY (origin_event_id) REFERENCES ingestion_events(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_links_edge
  ON memory_links(business_id, from_page_id, to_page_id, link_type, origin_event_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_business_from
  ON memory_links(business_id, from_page_id, link_type);
CREATE INDEX IF NOT EXISTS idx_memory_links_business_to
  ON memory_links(business_id, to_page_id, link_type);

CREATE TABLE IF NOT EXISTS memory_provenance (
  memory_kind     TEXT NOT NULL CHECK(memory_kind IN ('fact','take','link','page')),
  memory_id       TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  business_id     TEXT NOT NULL,
  attached_at_ms  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (memory_kind, memory_id, source_event_id),
  FOREIGN KEY (source_event_id) REFERENCES ingestion_events(id)
);

CREATE INDEX IF NOT EXISTS idx_provenance_business_event
  ON memory_provenance(business_id, source_event_id);
