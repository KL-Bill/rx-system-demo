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

CREATE TABLE strengths (
  id SERIAL PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  registration_number TEXT,
  classification TEXT,
  ihf BOOLEAN NOT NULL DEFAULT false,
  volume_ml NUMERIC,
  reg_approx BOOLEAN
);

CREATE INDEX idx_brands_generic ON brands (generic_id);
CREATE INDEX idx_forms_brand ON forms (brand_id);
CREATE INDEX idx_strengths_form ON strengths (form_id);
CREATE INDEX idx_generics_name ON generics (lower(generic_name));

-- ---------- users / stations / doctors ----------
-- ids keep the app's existing "prefix-uuid8" text-id scheme (see newId() in
-- src/_db/store.js) for continuity with data already handed out to users.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL
);

CREATE TABLE doctors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  license TEXT
);

-- ---------- prescriptions ----------
-- station_id/department/created_at are promoted to real columns because
-- src/models/demand.js and src/models/pharmacy.js filter/group on them
-- directly; doctor/patient/address/age/sex/items stay in payload since
-- they're only ever read back whole, never queried by field.

CREATE TABLE prescriptions (
  id TEXT PRIMARY KEY,
  station_id TEXT REFERENCES stations(id),
  department TEXT,
  created_at BIGINT NOT NULL,
  payload JSONB NOT NULL
);

CREATE INDEX idx_prescriptions_created_at ON prescriptions (created_at);
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
