-- Links Fixera records to the IDs used by the existing fixbridge.us database, so the site can
-- keep its own IDs (integers, UUIDs, anything) and Fixera keeps its own.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS properties_external_ref_idx ON properties(external_ref) WHERE external_ref IS NOT NULL;
ALTER TABLE property_equipment ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS property_equipment_external_ref_idx ON property_equipment(property_id, external_ref) WHERE external_ref IS NOT NULL;
