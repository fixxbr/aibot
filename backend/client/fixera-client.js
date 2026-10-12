// Headless browser client for calling Fixera from the existing fixbridge.us pages.
// No UI, no styles: your current screens call these functions and render the results.
//
//   import { createFixeraClient } from 'fixera-core/client';   // or copy this file into the site
//   const fixera = createFixeraClient({
//     baseUrl: 'https://api.fixbridge.us/api/fixera',          // where the backend mounts Fixera
//     getToken: () => yourExistingSession.token,               // omit if you use cookie sessions
//   });

export function createFixeraClient({ baseUrl = '/api/fixera', getToken, credentials = 'include', fetchImpl = fetch } = {}) {
  const root = baseUrl.replace(/\/$/, '');
  const origin = root.replace(/\/api\/fixera$/, '');

  async function call(path, { method = 'GET', body, form } = {}) {
    const headers = {};
    const token = getToken ? await getToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${root}${path}`, { method, headers, credentials, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Fixera request failed (${res.status})`);
      err.status = res.status;
      err.code = data?.error?.code; // e.g. subscription_required, conflict, too_many_photos
      throw err;
    }
    return data;
  }

  const client = {
    // Configuration
    categories: () => call('/categories'),
    entitlement: () => call('/entitlement'), // { eligible } -> show/hide your AI Analysis option
    dispatchFee: (category) => call(`/dispatch-fee?category=${encodeURIComponent(category)}`),

    // Property Passport
    properties: () => call('/properties'),
    passport: (propertyId) => call(`/properties/${propertyId}/passport`),
    addEquipment: (propertyId, equipment) => call(`/properties/${propertyId}/equipment`, { method: 'POST', body: equipment }),

    // Service request / case
    /** Pass propertyRef (your site's property id, synced with fixera.sync.upsertProperty) or Fixera's propertyId. */
    createCase: ({ propertyId, propertyRef, category, description, equipmentId }) =>
      call('/cases', { method: 'POST', body: { property_id: propertyId, property_ref: propertyRef, category, description, equipment_id: equipmentId } }),
    /** files: File[] from your Take Photo (captureSource 'camera') or Upload Photo ('upload') input. */
    uploadPhotos: (caseId, files, captureSource = 'upload') => {
      const form = new FormData();
      form.append('capture_source', captureSource);
      for (const f of files) form.append('photos', f, f.name || 'photo.jpg');
      return call(`/cases/${caseId}/media`, { method: 'POST', form });
    },
    listCases: (propertyId) => call(`/cases${propertyId ? `?property_id=${propertyId}` : ''}`),
    getCase: (caseId) => call(`/cases/${caseId}`), // restores everything after a reload
    status: (caseId) => call(`/cases/${caseId}/status`),

    // AI path (requires HomeCare Pro; server returns code 'subscription_required' otherwise)
    analyze: (caseId) => call(`/cases/${caseId}/analyze`, { method: 'POST' }),
    sendMessage: (caseId, content, mediaIds = []) => call(`/cases/${caseId}/messages`, { method: 'POST', body: { content, media_ids: mediaIds } }),
    /** result: done | worked | not_worked | need_help | unexpected_condition | skipped */
    stepResult: (caseId, stepId, result, note, mediaIds) =>
      call(`/cases/${caseId}/steps/${stepId}/result`, { method: 'POST', body: { result, note, media_ids: mediaIds } }),
    feedback: (caseId, { rating, helpful, comment }) => call(`/cases/${caseId}/feedback`, { method: 'POST', body: { rating, helpful, comment } }),
    outcome: (caseId, resolution, note) => call(`/cases/${caseId}/outcome`, { method: 'POST', body: { resolution, note } }),

    // Professional path (works with or without AI analysis)
    hirePro: (caseId, { preferredDate, preferredWindow, notes }) =>
      call(`/cases/${caseId}/hire-pro`, { method: 'POST', body: { preferred_date: preferredDate, preferred_window: preferredWindow, notes } }),

    /** Photos are private. Returns an object URL for an <img>; revoke it when done. */
    async photoUrl(mediaUrl) {
      const headers = {};
      const token = getToken ? await getToken() : null;
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchImpl(mediaUrl.startsWith('http') ? mediaUrl : `${origin}${mediaUrl}`, { headers, credentials });
      if (!res.ok) throw new Error(`Photo unavailable (${res.status})`);
      return URL.createObjectURL(await res.blob());
    },

    /**
     * Waits for an analysis started by analyze/sendMessage/stepResult and returns the full case.
     * onStatus lets your existing progress UI react; Fixera reports no fake percentages.
     */
    async waitForAnalysis(caseId, { intervalMs = 2500, timeoutMs = 6 * 60_000, onStatus, signal } = {}) {
      const started = Date.now();
      for (;;) {
        if (signal?.aborted) throw new Error('aborted');
        const s = await client.status(caseId);
        onStatus?.(s);
        if (s.status !== 'ANALYZING') return client.getCase(caseId);
        if (Date.now() - started > timeoutMs) throw Object.assign(new Error('Analysis is taking longer than expected; it will continue in the background.'), { code: 'still_running' });
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
  return client;
}
