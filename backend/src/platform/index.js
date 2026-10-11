// Platform adapter: everything Fixera needs from FixBridge, behind one interface.
//
// Fixera never decides who a user is, what a subscription costs, or how payment and
// dispatch work. It asks the platform. This default implementation reads the tables in
// 001_core.sql. Inside FixBridge, replace individual methods to call the existing
// auth/session code, Stripe subscription records, pricing settings and dispatch service.

import jwt from 'jsonwebtoken';
import { HttpError } from '../middleware/errors.js';

export function createPlatformAdapter({ db, config, authenticate }) {
  return {
    // Pass `authenticate` to reuse FixBridge's existing login/session, e.g.
    //   authenticate: async (req) => req.user && { id: req.user.id, role: req.user.role }
    async authenticate(req) {
      if (authenticate) return authenticate(req);
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token || !config.auth.jwtSecret) return null;
      let claims;
      try {
        claims = jwt.verify(token, config.auth.jwtSecret, {
          algorithms: ['HS256'],
          issuer: config.auth.jwtIssuer,
          audience: config.auth.jwtAudience,
        });
      } catch {
        return null;
      }
      if (!claims.sub) return null;
      // Role comes from the database record, not only from the token.
      const { rows } = await db.query('SELECT id, role FROM users WHERE id = $1', [String(claims.sub)]);
      if (!rows[0]) return null;
      return { id: rows[0].id, role: rows[0].role };
    },

    // HomeCare Pro entitlement for paid AI analysis.
    async getAnalysisEntitlement(userId) {
      const plan = await this.getSetting('homecare_pro_plan', { plan: 'homecare_pro' });
      const { rows } = await db.query(
        `SELECT status, current_period_end FROM subscriptions
          WHERE user_id = $1 AND plan = $2 AND status IN ('active', 'trialing')
            AND (current_period_end IS NULL OR current_period_end > now())
          ORDER BY created_at DESC LIMIT 1`,
        [userId, plan.plan],
      );
      return { eligible: rows.length > 0, plan: plan.plan, priceCents: plan.price_cents ?? null };
    },

    async getSetting(key, fallback) {
      const { rows } = await db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
      return rows[0] ? rows[0].value : fallback;
    },

    async listServiceCategories() {
      const { rows } = await db.query('SELECT slug, name FROM service_categories WHERE active ORDER BY name');
      return rows;
    },

    async getServiceCategory(slug) {
      const { rows } = await db.query('SELECT slug, name, active, dispatch_fee_cents FROM service_categories WHERE slug = $1', [slug]);
      return rows[0] && rows[0].active ? rows[0] : null;
    },

    // Dispatch fee always comes from platform pricing configuration.
    async getDispatchFeeCents(categorySlug) {
      const cat = await this.getServiceCategory(categorySlug);
      if (cat?.dispatch_fee_cents != null) return cat.dispatch_fee_cents;
      const fee = await this.getSetting('dispatch_fee_default_cents', null);
      if (fee == null) throw new HttpError(503, 'pricing_unavailable', 'Dispatch pricing is not configured');
      return Number(fee);
    },

    // Creates the service request in FixBridge's dispatch workflow. Payment is collected by
    // FixBridge's existing Stripe flow; the request starts as pending_payment.
    // `fee` must be read with getDispatchFeeCents() before opening the transaction `q`.
    async createServiceRequest(q, { propertyId, customerId, category, description, preferredDate, preferredWindow, caseId, assessmentId, handoff, fee }) {
      const { rows } = await q.query(
        `INSERT INTO service_requests
           (property_id, customer_id, category, description, preferred_date, preferred_window,
            dispatch_fee_cents, fixera_case_id, fixera_assessment_id, handoff)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         RETURNING id, status, dispatch_fee_cents, preferred_date, preferred_window, created_at`,
        [propertyId, customerId, category, description, preferredDate || null, preferredWindow || null, fee, caseId || null, assessmentId || null, JSON.stringify(handoff || {})],
      );
      return { ...rows[0], payment: { required: true, amount_cents: fee, currency: 'USD', next_action: 'collect_payment' } };
    },
  };
}
