-- rx-system Postgres schema.
-- Replaces the two flat-JSON stores: data.json (src/_db/store.js) and
-- src/_db/medicines.json (src/_db/db_functions.js).

-- ---------- medicines catalog ----------
-- generic -> brand -> form -> strength, mirroring medicines.json's tree.
-- SERIAL (not the JSON file's plain incrementing ints) so addToCatalog() can
-- INSERT ... RETURNING id instead of generating ids in application code.

CREATE TABLE generics (
  id SERIAL PRIMARY KEY,
  generic_name TEXT NOT NULL,
  in_pnf BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE brands (
  id SERIAL PRIMARY KEY,
  generic_id INTEGER NOT NULL REFERENCES generics(id) ON DELETE CASCADE,
  brand_name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE forms (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  form_name TEXT NOT NULL DEFAULT ''
);

-- ihf = "in Bizbox" (the hospital's dispensing system; the UI says Bizbox, the
-- column keeps its original name). description is the Bizbox wording of the
-- product — "BIOGESIC 500MG TABLET" — the real text once a Bizbox import has
-- seen it, else brand + strength + form stitched in that order. It is what the
-- nurse's Brand/Form/Strength box searches and shows; brand/form/strength stay
-- the structured fields the slip and the demand grouping use.
CREATE TABLE strengths (
  id SERIAL PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  registration_number TEXT,
  classification TEXT,
  ihf BOOLEAN NOT NULL DEFAULT false,
  volume_ml NUMERIC,
  reg_approx BOOLEAN,
  description TEXT,
  bizbox_seen_at BIGINT,
  -- soft delete: a duplicate merged away on the RX Formulary page keeps its
  -- row, pointing at the one kept, so IT can bring it back
  deleted_at BIGINT,
  merged_into INTEGER
);

CREATE INDEX idx_brands_generic ON brands (generic_id);
CREATE INDEX idx_forms_brand ON forms (brand_id);
CREATE INDEX idx_strengths_form ON strengths (form_id);
CREATE INDEX idx_generics_name ON generics (lower(generic_name));

-- Autocomplete (db.suggestOptions) and exact product lookup (db.findProduct)
-- both match on lower(trim(...)); the plain lower() index above cannot serve
-- those, so each level gets a matching expression index.
CREATE INDEX idx_generics_name_trim ON generics (lower(trim(generic_name)));
CREATE INDEX idx_brands_name_trim ON brands (lower(trim(brand_name)));
CREATE INDEX idx_forms_name_trim ON forms (lower(trim(form_name)));
CREATE INDEX idx_strengths_label_trim ON strengths (lower(trim(label)));
CREATE INDEX idx_strengths_description_trim ON strengths (lower(trim(description)));

-- ---------- users / stations / doctors ----------
-- ids keep the app's existing "prefix-uuid8" text-id scheme (see newId() in
-- src/_db/store.js) for continuity with data already handed out to users.

-- role: 'admin' (pharmacy head), 'staff' (pharmacy staff), 'it' (system
-- administration). Nurses have no login. Deactivated accounts keep their row
-- (active = false) so audit entries still point at a real user.
-- is_master: an IT account made at the server console (scripts/create-admin.js).
-- Only master IT manages accounts; IT accounts made on the IT page are not
-- master and never see the Accounts tab.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  is_master BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL
);

CREATE TABLE doctors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  license TEXT,
  deleted_at BIGINT              -- soft delete (IT page); NULL = offered to nurses
);

-- ---------- prescriptions ----------
-- station_id/department/created_at are promoted to real columns because
-- src/models/demand.js and src/models/pharmacy.js filter/group on them
-- directly; doctor/patient/address/age/sex/items stay in payload since
-- they're only ever read back whole, never queried by field.

-- deleted_at/deleted_by: soft delete from the IT page. A deleted prescription
-- leaves every list, count and report but stays on disk; IT can restore it.
CREATE TABLE prescriptions (
  id TEXT PRIMARY KEY,
  station_id TEXT REFERENCES stations(id),
  department TEXT,
  created_at BIGINT NOT NULL,
  payload JSONB NOT NULL,
  deleted_at BIGINT,
  deleted_by TEXT
);

CREATE INDEX idx_prescriptions_created_at ON prescriptions (created_at);
CREATE INDEX idx_prescriptions_live ON prescriptions (created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_prescriptions_station ON prescriptions (station_id);
CREATE INDEX idx_prescriptions_department ON prescriptions (department);

-- ---------- review status ----------
-- one row per (reason, drug key) pair, matching db.getStatus(reason, key) /
-- db.setStatus(reason, key, rec) in src/_db/db_functions.js.

CREATE TABLE review_status (
  reason TEXT NOT NULL,
  drug_key TEXT NOT NULL,
  status TEXT NOT NULL,
  status_date BIGINT NOT NULL,
  actor TEXT,
  authorized_by TEXT,
  PRIMARY KEY (reason, drug_key)
);

-- ---------- review remarks ----------
-- the pharmacy's explanation for why a reviewed drug is still open (or how it
-- was closed): one row per remark, never overwritten — auditors read the
-- history. remark is a preset key (available_in_bizbox, ordered, for_order,
-- other_brand_only, under_therapeutics, other); note is free text.

CREATE TABLE review_remarks (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  drug_key TEXT NOT NULL,
  remark TEXT NOT NULL,
  note TEXT,
  actor TEXT,
  authorized_by TEXT,
  at BIGINT NOT NULL
);

CREATE INDEX idx_review_remarks_drug ON review_remarks (reason, drug_key, at DESC);

-- ---------- Bizbox imports ----------
-- One row per uploaded Bizbox export. The row IS the job: the analyze and
-- apply phases update processed/total as they go and the page polls it — the
-- app runs several workers, so progress cannot live in one process's memory.
-- rows keeps every parsed line and the reviewer's decision on it, which is the
-- audit trail of what an import changed and who said so.
-- status: analyzing | awaiting_review | applying | done | cancelled | failed

CREATE TABLE catalog_imports (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  uploaded_by TEXT,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  summary JSONB,
  rows JSONB
);

CREATE INDEX idx_catalog_imports_started ON catalog_imports (started_at DESC);

-- descriptions a reviewer excluded with "remember for next time" — non-drugs
-- the export carries (NITROGEN USE, MEDEXPRESS PAYABLE). Keyed on the
-- lower-cased, whitespace-collapsed text so the next import skips them.

CREATE TABLE catalog_import_exclusions (
  description_key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  excluded_by TEXT,
  at BIGINT NOT NULL
);

-- ---------- audit log ----------
-- fields match every db.addAudit(...) call site (src/models/pharmacy.js):
-- { action, drug, reason, status, actor, authorizedBy }.

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  action TEXT,
  drug TEXT,
  reason TEXT,
  status TEXT,
  actor TEXT,
  authorized_by TEXT
);

CREATE INDEX idx_audit_log_at ON audit_log (at DESC);

-- ---------- system log (IT page) ----------
-- app-level events: logins (success/failure), logouts, account management,
-- prescriptions printed (station/department only — no patient data), backups.
-- Grows unbounded; always read through getSystemLogs()'s LIMIT/OFFSET.

CREATE TABLE system_logs (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  role TEXT,
  target TEXT,
  ip TEXT,
  details JSONB
);

CREATE INDEX idx_system_logs_at ON system_logs (at DESC);
CREATE INDEX idx_system_logs_type ON system_logs (type);

-- ---------- backups (IT page) ----------
-- One row per scripts/backup-db.ps1 run, inserted by the script itself via
-- `podman exec ... psql`. The app runs inside the pod and cannot see the
-- host's backup directory — this table is the shared channel. SERIAL id so
-- the PowerShell-side INSERT stays trivial.

CREATE TABLE backups (
  id SERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  file TEXT NOT NULL,
  size_bytes BIGINT,
  duration_ms BIGINT,
  status TEXT NOT NULL
);

CREATE INDEX idx_backups_at ON backups (at DESC);
