-- Fixera core schema.
--
-- Tables without the fixera_ prefix (properties, property_equipment, subscriptions,
-- service_categories, service_requests, ...) mirror entities that FixBridge already owns.
-- They exist here so Fixera can run standalone and in tests. When Fixera is mounted inside
-- the FixBridge backend, point the platform adapter (src/platform) at the existing tables
-- instead of creating duplicates. Everything is CREATE ... IF NOT EXISTS so this file is safe
-- to run against a database that already has them.

-- ---------------------------------------------------------------------------
-- Platform entities (owned by FixBridge)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'homeowner' CHECK (role IN ('homeowner', 'contractor', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT NOT NULL REFERENCES users(id),
  plan                TEXT NOT NULL,              -- e.g. 'homecare_pro'
  status              TEXT NOT NULL,              -- active | trialing | past_due | canceled
  current_period_end  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_categories (
  slug                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  active               BOOLEAN NOT NULL DEFAULT true,
  dispatch_fee_cents   INTEGER                       -- NULL = use platform default
);

CREATE TABLE IF NOT EXISTS properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  nickname        TEXT,
  address_line1   TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT NOT NULL,
  property_type   TEXT,
  year_built      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS properties_owner_idx ON properties(owner_user_id);

-- Delegated access (co-owners, property managers). Ownership is on properties.owner_user_id.
CREATE TABLE IF NOT EXISTS property_access (
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  access_level  TEXT NOT NULL CHECK (access_level IN ('read', 'manage')),
  PRIMARY KEY (property_id, user_id)
);

CREATE TABLE IF NOT EXISTS property_equipment (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  equipment_type    TEXT NOT NULL,          -- e.g. 'Central HVAC', 'Water heater'
  brand             TEXT,
  model_number      TEXT,
  serial_number     TEXT,
  installed_on      DATE,
  location          TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS property_equipment_property_idx ON property_equipment(property_id);

-- Property Passport timeline: maintenance, repairs, inspections, outcomes.
CREATE TABLE IF NOT EXISTS property_service_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  equipment_id         UUID REFERENCES property_equipment(id) ON DELETE SET NULL,
  category             TEXT,
  event_type           TEXT NOT NULL CHECK (event_type IN ('maintenance', 'repair', 'inspection', 'diy_outcome', 'contractor_completion', 'note')),
  summary              TEXT NOT NULL,
  details              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Who asserted this: homeowner_reported | contractor_recorded | verified | imported
  verification_status  TEXT NOT NULL DEFAULT 'homeowner_reported',
  cost_cents           INTEGER,
  occurred_on          DATE NOT NULL DEFAULT CURRENT_DATE,
  source_case_id       UUID,
  source_service_request_id UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS property_service_history_property_idx ON property_service_history(property_id, occurred_on DESC);

CREATE TABLE IF NOT EXISTS property_reminders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  equipment_id  UUID REFERENCES property_equipment(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  due_on        DATE NOT NULL,
  recurrence_days INTEGER,
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Fixera cases
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fixera_cases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref       TEXT NOT NULL UNIQUE,                 -- FX-xxxxx, safe to show
  property_id      UUID NOT NULL REFERENCES properties(id),
  customer_id      TEXT NOT NULL REFERENCES users(id),
  category         TEXT NOT NULL REFERENCES service_categories(slug),
  equipment_id     UUID REFERENCES property_equipment(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  status           TEXT NOT NULL,
  status_detail    TEXT,                                  -- e.g. recoverable error reason
  latest_assessment_id UUID,
  service_request_id   UUID,
  version          INTEGER NOT NULL DEFAULT 1,            -- optimistic concurrency
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixera_cases_property_idx ON fixera_cases(property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fixera_cases_customer_idx ON fixera_cases(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fixera_case_events (
  id          BIGSERIAL PRIMARY KEY,
  case_id     UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fixera_media (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  uploaded_by    TEXT NOT NULL REFERENCES users(id),
  storage_driver TEXT NOT NULL,
  storage_key    TEXT NOT NULL,                 -- private object key, never a public URL
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  width          INTEGER,
  height         INTEGER,
  sha256         TEXT NOT NULL,
  capture_source TEXT NOT NULL CHECK (capture_source IN ('camera', 'upload')),
  label          TEXT,                          -- short stable label used in prompts: photo_1, photo_2...
  quality_flags  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixera_media_case_idx ON fixera_media(case_id, created_at);

CREATE TABLE IF NOT EXISTS fixera_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('homeowner', 'assistant', 'system')),
  kind        TEXT NOT NULL DEFAULT 'text',     -- text | step_result | photo_added | assessment | handoff
  content     TEXT NOT NULL,
  media_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  assessment_id UUID,
  author_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq)
);

CREATE TABLE IF NOT EXISTS fixera_assessments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  trigger           TEXT NOT NULL,             -- initial | message | photo | step_result | rerun
  result_status     TEXT NOT NULL,
  risk_level        TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MODERATE', 'HIGH', 'EMERGENCY')),
  diy_permitted     BOOLEAN NOT NULL,
  visual_analysis_performed BOOLEAN NOT NULL,
  result            JSONB NOT NULL,            -- validated, safety-enforced assessment
  provider          TEXT,
  model             TEXT,
  provider_run_id   UUID,
  prompt_version    TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  evidence_media_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, version)
);

CREATE TABLE IF NOT EXISTS fixera_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  UUID NOT NULL REFERENCES fixera_assessments(id) ON DELETE CASCADE,
  case_id        UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  action_type    TEXT NOT NULL CHECK (action_type IN ('observe', 'safe_check', 'repair', 'verify')),
  title          TEXT NOT NULL,
  instruction    TEXT NOT NULL,
  caution        TEXT,
  stop_condition TEXT,
  verification   TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'worked', 'not_worked', 'need_help', 'unexpected_condition', 'skipped', 'superseded')),
  result_note    TEXT,
  completed_at   TIMESTAMPTZ,
  UNIQUE (assessment_id, seq)
);
CREATE INDEX IF NOT EXISTS fixera_steps_case_idx ON fixera_steps(case_id);

CREATE TABLE IF NOT EXISTS fixera_outcomes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  resolution           TEXT NOT NULL CHECK (resolution IN ('resolved', 'unresolved', 'not_verified')),
  -- homeowner_reported | contractor_recorded | verified
  verification_status  TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('homeowner', 'contractor', 'admin')),
  reported_by          TEXT NOT NULL,
  final_diagnosis      TEXT,
  work_performed       TEXT,
  parts_replaced       JSONB NOT NULL DEFAULT '[]'::jsonb,
  actual_cost_cents    INTEGER,
  ai_accuracy          TEXT CHECK (ai_accuracy IN ('correct', 'partially_correct', 'incorrect', 'not_assessed')),
  notes                TEXT,
  evidence_media_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fixera_feedback (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES fixera_cases(id) ON DELETE CASCADE,
  assessment_id UUID REFERENCES fixera_assessments(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,             -- homeowner_rating | diagnosis_mismatch | correction | safety_concern
  rating       INTEGER CHECK (rating BETWEEN 1 AND 5),
  helpful      BOOLEAN,
  comment      TEXT,
  author_id    TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'open' CHECK (review_state IN ('open', 'reviewed', 'dismissed', 'promoted')),
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fixera_provider_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID REFERENCES fixera_cases(id) ON DELETE SET NULL,
  task             TEXT NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  status           TEXT NOT NULL,          -- ok | invalid_output | error | timeout | refused | skipped
  error_code       TEXT,
  latency_ms       INTEGER,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cost_usd_micros  INTEGER,
  image_count      INTEGER NOT NULL DEFAULT 0,
  vision_used      BOOLEAN NOT NULL DEFAULT false,
  validation       TEXT,
  prompt_version   TEXT,
  policy_version   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixera_provider_runs_created_idx ON fixera_provider_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS fixera_provider_config (
  provider     TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  priority     INTEGER NOT NULL DEFAULT 100,
  model        TEXT,
  timeout_ms   INTEGER,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Knowledge Base
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  source_type    TEXT NOT NULL CHECK (source_type IN ('manufacturer_manual', 'repair_guide', 'reviewed_case', 'safety_rule', 'parts_reference', 'decision_tree')),
  source_ref     TEXT,                      -- URL, manual number, internal reference
  category       TEXT,
  equipment_type TEXT,
  brand          TEXT,
  model_pattern  TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  review_state   TEXT NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft', 'approved', 'retired')),
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  heading      TEXT,
  content      TEXT NOT NULL,
  tsv          TSVECTOR NOT NULL,
  UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);

-- ---------------------------------------------------------------------------
-- Pricing (deterministic, admin-maintained)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pricing_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category      TEXT NOT NULL,
  issue_key     TEXT NOT NULL,             -- e.g. plumbing.p_trap_leak
  description   TEXT NOT NULL,
  zip_prefix    TEXT,                      -- NULL = national baseline; '331' or '33101'
  parts_min_cents INTEGER,
  parts_max_cents INTEGER,
  labor_min_cents INTEGER,
  labor_max_cents INTEGER,
  source        TEXT NOT NULL,             -- where the numbers came from
  effective_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  active        BOOLEAN NOT NULL DEFAULT true,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pricing_rules_lookup_idx ON pricing_rules(issue_key, zip_prefix) WHERE active;

-- ---------------------------------------------------------------------------
-- Professional handoff (FixBridge dispatch workflow owns the lifecycle)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID NOT NULL REFERENCES properties(id),
  customer_id           TEXT NOT NULL REFERENCES users(id),
  category              TEXT NOT NULL REFERENCES service_categories(slug),
  description           TEXT NOT NULL,
  preferred_date        DATE,
  preferred_window      TEXT CHECK (preferred_window IN ('morning', 'midday', 'afternoon', 'evening')),
  dispatch_fee_cents    INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending_payment',
  assigned_contractor_id TEXT REFERENCES users(id),
  fixera_case_id        UUID REFERENCES fixera_cases(id),
  fixera_assessment_id  UUID REFERENCES fixera_assessments(id),
  handoff               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- snapshot given to the contractor
  -- Separate monetary concepts; never overwrite one with another.
  contractor_quote_cents INTEGER,
  approved_amount_cents  INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_requests_contractor_idx ON service_requests(assigned_contractor_id);

-- Audit trail for admin changes to safety, pricing, providers and knowledge.
CREATE TABLE IF NOT EXISTS fixera_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defaults FixBridge admins can change. Fixera never hardcodes these.
INSERT INTO platform_settings (key, value) VALUES
  ('dispatch_fee_default_cents', '12500'::jsonb),
  ('homecare_pro_plan', '{"plan": "homecare_pro", "price_cents": 2900, "interval": "month"}'::jsonb),
  ('max_photos_per_case', '6'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO service_categories (slug, name) VALUES
  ('hvac', 'HVAC'),
  ('plumbing', 'Plumbing'),
  ('electrical', 'Electrical'),
  ('appliance', 'Appliance Repair'),
  ('roofing', 'Roofing'),
  ('general', 'General Handyman')
ON CONFLICT (slug) DO NOTHING;
