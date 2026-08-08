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

-- Interned lookups. The server owns this ID space: append-only and never
-- renumbered (D-025 hazard 1). Each build seeds from the previous artifact, so
-- an id means the same value in every artifact and every delta; a value the
-- corpus stops using loses its row but keeps its id reserved forever (D-056).
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
--
-- The four trailing columns are D-070's, added at schema 2. **NULL is a value
-- here and means "not assessed"**, which is a different fact from `none`:
-- `ssvc_expl = 0` is someone having looked and found no known exploitation,
-- while NULL is the absence of the assessment entirely, and 51.9% of the corpus
-- is in that state. Folding the two would understate every band -- the same
-- failure D-022 guards against for REJECTED records and D-073 for unscored CVSS.
CREATE TABLE cve(
  id          INTEGER PRIMARY KEY,
  cve_id      TEXT UNIQUE,         -- the client does look records up by ID
  year        INT,
  state       INT,
  cna_id      INT,
  published   INT,                 -- unix seconds
  updated     INT,
  cvss_ver    INT,
  cvss_score  REAL,
  cvss_sev    INT,
  cvss_vec    TEXT,
  reserved    INT,                 -- dateReserved, unix seconds. 100% coverage
  ssvc_expl   INT,                 -- 0 none, 1 poc, 2 active
  ssvc_auto   INT,                 -- 0 no, 1 yes
  ssvc_impact INT                  -- 0 partial, 1 total
);

-- English only (D-023). A record with none of the three has no row here, and one
-- with no `descr` cannot match a description search -- which the UI must not
-- report as "no results".
--
-- `reason` is separate from `descr` rather than folded into it because 0% of the
-- 17,822 REJECTED records carry an English description: all of their text is in
-- `rejectedReasons`, and merging it would put the rejection boilerplate in the
-- description index (D-070).
CREATE TABLE cve_text(cve_id INTEGER PRIMARY KEY, descr TEXT, title TEXT, reason TEXT);

CREATE TABLE cve_cwe (cve_id INT, cwe_id     INT, PRIMARY KEY(cve_id, cwe_id))     WITHOUT ROWID;
CREATE TABLE cve_ref (cve_id INT, url_id     INT, PRIMARY KEY(cve_id, url_id))     WITHOUT ROWID;

-- default_status: the container default that governs every version *not* listed
-- in cve_ver, in cve_ver.status's own vocabulary -- 1 affected, 2 unaffected,
-- 3 unknown -- and NULL when the record states none. A correctness fix rather
-- than an enrichment (D-070): with `defaultStatus: affected`, the listed
-- `unaffected` rows are the *fixed* versions and everything else is vulnerable,
-- the inverse of the natural reading of the rows alone.
CREATE TABLE cve_prod(
  cve_id     INT,
  product_id INT,
  default_status INT,
  PRIMARY KEY(cve_id, product_id)
) WITHOUT ROWID;

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
-- Keys: rev, schema, generated, notice — plus the ID space's own record, which
-- the client ignores and the next build and delta read: hwm (the per-table
-- high-water ids, in the changeset's `floors` shape), cve_hwm, idspace, and
-- (on a seeded build) seed_rev, seed_marks, seed_fingerprint (D-056).
CREATE TABLE meta(k TEXT PRIMARY KEY, v);

-- No index on cvss_sev, and none on the three SSVC columns either. They are
-- low-cardinality codes on the corpus table, so every grouped count over them is
-- a scan of `cve` whichever way it is written, and an index would cost download
-- bytes for every user to save none of them -- the same trade D-033 made.
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
