// Deterministic cost estimates from admin-maintained pricing rules. The model only picks a
// pricing key; it never produces dollar amounts. Missing data is reported as unavailable.

export function createPricingService({ db }) {
  async function catalog(category) {
    const { rows } = await db.query(
      `SELECT DISTINCT issue_key, description FROM pricing_rules WHERE active AND category = $1 ORDER BY issue_key`,
      [category],
    );
    return rows;
  }

  async function estimate({ category, issueKey, zip, professionalRequired }) {
    const base = {
      type: 'ai_market_estimate',
      currency: 'USD',
      issue_key: issueKey || null,
      parts_min_cents: null,
      parts_max_cents: null,
      labor_min_cents: null,
      labor_max_cents: null,
      includes_labor: false,
      pricing_source: 'unavailable',
      region: null,
      source_note: null,
      disclaimer: 'Estimates are approximate and are not a quote. A contractor quote is the only binding price.',
    };
    if (!issueKey) return { ...base, source_note: 'Not enough information to estimate cost yet.' };
    const zip5 = String(zip || '').slice(0, 5);
    const prefixes = [zip5, zip5.slice(0, 3)].filter((p) => p.length >= 3);
    const { rows } = await db.query(
      `SELECT * FROM pricing_rules
        WHERE active AND category = $1 AND issue_key = $2 AND (zip_prefix IS NULL OR zip_prefix = ANY($3::text[]))
        ORDER BY length(coalesce(zip_prefix, '')) DESC, effective_on DESC
        LIMIT 1`,
      [category, issueKey, prefixes],
    );
    const r = rows[0];
    if (!r) return { ...base, source_note: 'No pricing data is available for this issue yet.' };
    const includeLabor = Boolean(professionalRequired) && r.labor_min_cents != null;
    return {
      ...base,
      parts_min_cents: r.parts_min_cents,
      parts_max_cents: r.parts_max_cents,
      labor_min_cents: includeLabor ? r.labor_min_cents : null,
      labor_max_cents: includeLabor ? r.labor_max_cents : null,
      includes_labor: includeLabor,
      pricing_source: r.zip_prefix ? 'regional' : 'national_baseline',
      region: r.zip_prefix ? `ZIP ${r.zip_prefix}${r.zip_prefix.length === 3 ? 'xx' : ''}` : null,
      source_note: r.zip_prefix ? `Based on ${r.source}.` : `National baseline from ${r.source}; local data unavailable for ${zip5 || 'this ZIP'}.`,
      rule_id: r.id,
    };
  }

  return { catalog, estimate };
}
