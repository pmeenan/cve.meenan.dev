-- The published schema. Single source of truth (D-043): the builder executes
-- this file, and the client asserts against it after import.
--
-- Two properties here are load-bearing rather than stylistic:
--
--   * Link tables are WITHOUT ROWID with cve_id leading the primary key. Delta
--     apply replaces a record by deleting its dependent rows by cve_id, and the
--     spike's rowid table with only a (cwe_id, cve_id) index made that a full
--     scan costing 19x (D-031). Here the access path is structural.
--   * No UNIQUE constraints exist purely to support interning. Interning happens
--     once, on the server. `url TEXT UNIQUE` cost 59.7 MB — a second copy of
--     every URL — for a lookup the client never performs (D-033).
--
-- No FTS tables: the client builds its own indexes over descriptions, vendors
-- and products after import (D-035).

PRAGMA page_size = 4096;

-- Interned lookups. The server owns this ID space: append-only, never
-- renumbered, never garbage-collected (D-025 hazard 1).
CREATE TABLE cna(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE cwe(id INTEGER PRIMARY KEY, cwe TEXT, descr TEXT);
CREATE TABLE vendor(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE product(id INTEGER PRIMARY KEY, vendor_id INT, name TEXT);
CREATE TABLE host(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE url(id INTEGER PRIMARY KEY, url TEXT, host_id INT);
CREATE TABLE vtype(id INTEGER PRIMARY KEY, name TEXT);

-- state: 1 PUBLISHED, 2 REJECTED. Imported and filterable, excluded from
-- aggregates by default (D-022).
-- cvss_sev: 0 NONE, 1 LOW, 2 MEDIUM, 3 HIGH, 4 CRITICAL.
-- cvss_ver: 2, 30, 31, 4 -- highest available, adp mined then discarded (D-024).
CREATE TABLE cve(
  id         INTEGER PRIMARY KEY,
  cve_id     TEXT UNIQUE,          -- the client does look records up by ID
  year       INT,
  state      INT,
  cna_id     INT,
  published  INT,                  -- unix seconds
  updated    INT,
  cvss_ver   INT,
  cvss_score REAL,
  cvss_sev   INT,
  cvss_vec   TEXT
);

-- English only (D-023). Records with no English description have no row here
-- and cannot match a search -- which the UI must not report as "no results".
CREATE TABLE cve_text(cve_id INTEGER PRIMARY KEY, descr TEXT);

CREATE TABLE cve_cwe (cve_id INT, cwe_id     INT, PRIMARY KEY(cve_id, cwe_id))     WITHOUT ROWID;
CREATE TABLE cve_prod(cve_id INT, product_id INT, PRIMARY KEY(cve_id, product_id)) WITHOUT ROWID;
CREATE TABLE cve_ref (cve_id INT, url_id     INT, PRIMARY KEY(cve_id, url_id))     WITHOUT ROWID;

-- status: 1 affected, 2 unaffected, 3 unknown. Carries non-key columns and
-- permits duplicate (cve_id, product_id), so it needs its cve_id index declared.
CREATE TABLE cve_ver(
  cve_id     INT,
  product_id INT,
  status     INT,
  version    TEXT,
  lt         TEXT,   -- lessThan
  lte        TEXT,   -- lessThanOrEqual
  vtype      INT
);

-- Sync state lives in the database and advances in the same transaction as the
-- rows it describes, so a crash cannot leave the two disagreeing (D-031).
-- Keys: rev, schema, generated, notice.
CREATE TABLE meta(k TEXT PRIMARY KEY, v);

CREATE INDEX i_cve_year    ON cve(year);
CREATE INDEX i_cve_cna     ON cve(cna_id);
CREATE INDEX i_cve_score   ON cve(cvss_score);
CREATE INDEX i_cve_pub     ON cve(published);
CREATE INDEX i_cwe_rev     ON cve_cwe(cwe_id, cve_id);
CREATE INDEX i_prod_rev    ON cve_prod(product_id, cve_id);
CREATE INDEX i_ref_rev     ON cve_ref(url_id, cve_id);
CREATE INDEX i_ver_cve     ON cve_ver(cve_id);
CREATE INDEX i_ver_prod    ON cve_ver(product_id);
CREATE INDEX i_product_ven ON product(vendor_id);
CREATE INDEX i_url_host    ON url(host_id);
