# Fixera AI

## Integration path for fixbridge.us (start here)

FixBridge already has a working Fixera pipeline (`api/fixa/core.js` → `api/ai.js` → provider adapters). The smallest safe replacement is a **new provider behind `api/ai.js`**, so FixBridge keeps authorization, context selection, parsing, deterministic safety, pricing and persistence.

| Path | What it is |
| --- | --- |
| `integration/fixbridge/api/fixera-engine-provider.js` | Drop-in adapter for `api/ai.js` (`analyze` / `complete` / `createCompletion` / `extractDocument` / `isConfigured` / `health`). Zero dependencies. |
| `integration/fixbridge/README.md` | Exact resolver change, environment variables, Railway deploy, error-code mapping, cutover and rollback. |
| `backend/src/engine/` | **Fixera Engine**: a server-to-server inference service (`npm run start:engine`). Adds HMAC auth, a total deadline, real cancellation, vision-aware fallback, JSON validation, idempotency, async/durable jobs, contract versioning, and health that attests the commit and real inference. |

Read **[integration/fixbridge/README.md](integration/fixbridge/README.md)** to wire it in.

## Optional: full Fixera Core service (reference)

The rest of `backend/` is a complete standalone implementation of the Fixera developer guide:
- cases, Property Passport, Knowledge Base, safety engine, pricing, guided DIY, contractor handoff and learning loop
- a headless client for it

It is **not required** for the integration above, because FixBridge already owns those parts. It is kept as a reference and as a source of tested modules (the safety policy, grounding rules, provider adapters) that FixBridge can adopt piece by piece. The sections below describe it.

## Setup for the reference service: Neon + one AI key

**1. Neon database**
- In the Neon console, open your project and create a database named `fixera` (Databases → New database).
  - A separate database keeps Fixera's tables from colliding with your website's tables.
  - If the tables do clash, migration stops with a clear message before changing anything.
- Copy its connection string (Connection Details → pooled connection) into `backend/.env`:
  ```
  DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/fixera?sslmode=require&channel_binding=require
  ```
- Tables are created automatically on first start. pgvector is enabled automatically, since Neon supports it.

**2. One AI provider.** Any one of these is enough. Add more and Fixera falls back between them in `FIXERA_PROVIDER_ORDER`.

| Provider | Put in `backend/.env` | Notes |
| --- | --- | --- |
| Claude (Anthropic) | `ANTHROPIC_API_KEY=...` | Only the key is needed; defaults to `claude-opus-5-5`. Easiest option. |
| OpenRouter | `OPENROUTER_API_KEY=...` and `OPENROUTER_MODEL=...` | Use a model slug from openrouter.ai/models that accepts images. |
| OpenAI | `OPENAI_API_KEY=...` and `OPENAI_MODEL=...` | Use a vision-capable model from your OpenAI dashboard. |
| Gemini | `GEMINI_API_KEY=...` and `GEMINI_MODEL=...` | Use a Gemini model ID from Google AI Studio. |

**3. Verify both**
```bash
cd backend && npm install && npm run check
```
`npm run check`:
- connects to Neon and creates the tables
- sends one small real request per configured provider, with a test image, to prove the key works, the model name is right, the model can see photos and it returns Fixera's format
- tells you exactly what to fix if any of that fails

**4. Production settings** (Railway environment variables, never in the website code):
- `NODE_ENV=production`
- `FIXERA_JWT_SECRET` (or pass `authenticate` when mounting; see below)
- `MEDIA_DRIVER=s3` with your bucket settings

## Quick start (local development)

```bash
cd backend
npm install
cp .env.example .env              # add OPENROUTER_API_KEY / ANTHROPIC_API_KEY etc.
FIXERA_SEED_DEMO=true npm run dev # API on :4000 with an embedded DB; prints dev tokens for testing with curl
```

Run the tests with `cd backend && npm test`. Add `TEST_DATABASE_URL=postgres://...` to run them against a real PostgreSQL or Neon branch; each test file creates its own throwaway database. There are 48 tests: safety rules, authorization and isolation, image handling, provider failover, case continuity, DIY steps, handoff, the learning loop, and Fixera mounted inside a host app with its own login. They use an embedded database and scripted model providers, so they need no network or keys.

Run the evaluation scenarios against real providers with `npm run eval -- --yes`. These calls cost money. Put your own test photos in `backend/src/evaluations/fixtures/` to evaluate vision.

## How a request flows

```
Homeowner ─▶ POST /cases (property, category, description) ─▶ POST /cases/:id/media (Take Photo / Upload Photo)
                │
                ├─ Hire a Pro ─▶ POST /cases/:id/hire-pro ─▶ service request (fee from platform pricing, pending payment)
                │
                └─ AI Analysis ─▶ POST /cases/:id/analyze  (HomeCare Pro checked server-side) ─▶ 202, poll /status
                                     │
                                     ▼
            ┌──────────────────────── Fixera Core pipeline (src/fixera/orchestrator.js) ────────────────────────┐
            │ 1 auth + property access + entitlement (API layer)                                                 │
            │ 2 deterministic hazard screen ── EMERGENCY ─▶ emergency guidance, no model call                    │
            │ 3-5 context: Property Passport · prior cases · conversation · step progress · photos (bytes)        │
            │     · approved knowledge passages (full-text + optional pgvector) · pricing keys                   │
            │ 6-7 provider router: vision-capable model, strict JSON schema, timeout, retry once, fallback        │
            │ 8 grounding (drop claims about non-existent photos/records) + safety enforcement (policy wins)      │
            │ 9 status decision + deterministic ZIP pricing                                                      │
            │ 10 persist assessment, steps, assistant message, case status (one transaction)                     │
            └────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                     │
          messages / new photos / step results (same pipeline, same case) ◀──┘
                                     │
          outcome (homeowner_reported) ─ or ─ hire-pro ─▶ contractor completion (contractor_recorded)
                                                         ─▶ mismatch review ─▶ verified ─▶ redacted Knowledge Base entry
```

Every entry point (first analysis, follow-up message, photo added mid-repair, "I need help with this step") runs the same pipeline on the same case. Each model call is rebuilt from the database, never from a blank prompt.

## Design decisions

**Safety is deterministic and wins.** `src/fixera/safety/policy.js` is versioned (`POLICY_VERSION`). It defines:
- hazard rules (gas, CO, fire, water near electrical, collapse, exposed wiring, and more)
- category risk floors (electrical and roofing are never below MODERATE)
- prohibited DIY actions (panels and wiring, gas lines and pilots, refrigerant, capacitors, T&P valves, roof access, structural work, garage springs, chemical mixing, bypassing safety devices)

The model can raise the risk level but never lower it. Prohibited steps, tools and replies are removed *before* anything is stored or returned. Only rule IDs and counts are kept. A homeowner's "I accept the risk" changes nothing. Emergencies short-circuit without calling a model.

**Grounding.**
- Observations must cite a photo label that exists in the case, and only when a vision model actually received the image bytes.
- History and knowledge citations must be IDs that were actually given to the model.
- If every photo is poor or unusable, Fixera asks for specific photos.
- Repair steps are withheld until there is a "likely" cause and no outstanding photo request.

**Provider independence.**
- Adapters: OpenRouter, OpenAI, Gemini, Anthropic. The Anthropic adapter uses the official SDK, with server-side refusal fallbacks turned on.
- All adapters use one typed contract (`reasoning/schemas.js`). Output is validated with zod whatever the provider.
- The router skips text-only models for photo cases unless explicitly allowed, and marks those results `visual_analysis_performed: false`.
- A circuit breaker pauses failing providers.
- Every attempt is logged in `fixera_provider_runs`: provider, model, latency, tokens, cost, validation result, prompt and policy version. Prompts and outputs are never logged.

**Money is never invented.** The model only picks a `pricing_key`. `pricing/pricingService.js` resolves it from admin-maintained rules, most specific ZIP prefix first, then a national baseline, otherwise `unavailable`. These four amounts are separate fields that are never overwritten:
- AI estimate
- contractor quote
- approved amount
- payment

**Outcomes have provenance.** Each outcome is recorded as `homeowner_reported`, `contractor_recorded`, or `verified` (after admin review). Only admin-promoted, PII-redacted lessons enter the global Knowledge Base. A customer's history improves only their own future cases.

## API

Every route requires a FixBridge JWT. Property and case access is checked on the server for every read and write, and resources the caller can't access return 404.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/fixera/properties` · `/properties/:id/passport` | Properties, equipment, timeline, reminders |
| POST/PATCH | `/api/fixera/properties/:id/equipment[/:equipmentId]` | Maintain equipment records |
| GET | `/api/fixera/categories` · `/dispatch-fee?category=` · `/entitlement` | Platform configuration |
| POST | `/api/fixera/cases` | Create a case (draft service request) |
| POST | `/api/fixera/cases/:id/media` | Attach photos (multipart `photos`, `capture_source=camera\|upload`) |
| GET | `/api/fixera/cases/:id/media/:mediaId` | Authorized photo download |
| POST | `/api/fixera/cases/:id/analyze` | Run AI analysis (HomeCare Pro required). `202`, or `?wait=true` |
| GET | `/api/fixera/cases/:id` · `/status` | Full case restore / lightweight polling |
| POST | `/api/fixera/cases/:id/messages` | Continue troubleshooting, optionally with `media_ids` |
| POST | `/api/fixera/cases/:id/steps/:stepId/result` | `done`, `worked`, `not_worked`, `need_help`, `unexpected_condition`, `skipped` |
| POST | `/api/fixera/cases/:id/feedback` · `/outcome` · `/hire-pro` | Rating, homeowner resolution claim, professional handoff |
| GET/POST | `/api/fixera/contractor/jobs[/:id[/complete]]` | Assigned jobs, labelled handoff, completion |
| * | `/api/fixera/admin/...` | Providers, knowledge ingest/review, pricing rules, settings, safety policy, dispatch stand-in, review queue, evaluation summary |

Case states: `DRAFT → UPLOADED → ANALYZING → MORE_INFORMATION_REQUIRED | DIY_AVAILABLE | PROFESSIONAL_REQUIRED | EMERGENCY | ANALYSIS_FAILED → RESOLVED | UNRESOLVED | REFERRED`. `ANALYSIS_FAILED` is recoverable: the case can be retried or sent to a professional without re-entering anything.

## Integrating with fixbridge.us

### 1. Backend: mount Fixera inside the existing FixBridge server (Railway)

```bash
npm install ../path/to/aibot/backend   # or copy backend/ into the FixBridge repo as a package
```

```js
// in the existing FixBridge Express server, after your session/auth middleware
import { initFixera } from 'fixera-core';

const fixera = await initFixera({
  env: process.env,                                   // same Neon DATABASE_URL as FixBridge
  // Reuse the existing FixBridge login: return { id, role } or null.
  authenticate: async (req) => req.user ? { id: req.user.id, role: req.user.role } : null,
  // Optional: point these at existing FixBridge code instead of the default table-based versions.
  platform: {
    // getAnalysisEntitlement: async (userId) => ({ eligible: await stripeHasHomeCarePro(userId) }),
    // getDispatchFeeCents: async (category) => pricingSettings.dispatchFee(category),
    // createServiceRequest: async (q, request) => existingDispatch.create(request),  // returns { id, status, payment }
  },
});
app.use('/api/fixera', fixera.router);
```

- **Users, properties and subscriptions.** With Fixera on its own Neon database, keep it in step from the existing backend. Signed-in users are also registered automatically on their first request.
  ```js
  await fixera.sync.upsertUser({ id: user.id, role: 'homeowner', email: user.email });           // on sign-up
  await fixera.sync.upsertProperty({ externalRef: property.id, ownerUserId: user.id, zip: property.zip,
                                     nickname: property.name, city: property.city, state: property.state }); // on add/edit
  await fixera.sync.setSubscription({ userId: user.id, status: 'active' });                     // from the Stripe webhook
  ```
  Your pages can then open cases with your own property ID: `fixera.createCase({ propertyRef: property.id, ... })`.
- **Storage.** In production, set `MEDIA_DRIVER=s3` (S3/R2) and `npm i @aws-sdk/client-s3`. The server refuses to start with local storage in production.
- **Keys.** Set `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` and the other AI keys only in Railway environment variables. They never reach the browser.
- **CORS.** If the site on Netlify calls the Railway API on another domain, set `CORS_ORIGINS=https://fixbridge.us` in the backend's CORS configuration.

### 2. Website: call Fixera from your existing pages (Netlify)

Your current "New Service Request" screen keeps its layout. It replaces its submit logic with calls like these:

```js
import { createFixeraClient } from 'fixera-core/client';   // or copy backend/client/fixera-client.js into the site

const fixera = createFixeraClient({ baseUrl: 'https://<your-railway-api>/api/fixera', getToken: () => session.token });

// Step 1: your existing form
const { case: c } = await fixera.createCase({ propertyRef: property.id, category, description }); // your site's property id
await fixera.uploadPhotos(c.id, cameraFiles, 'camera');   // your "Take Photo" input
await fixera.uploadPhotos(c.id, uploadedFiles, 'upload'); // your "Upload Photo" input

// "Hire a Professional" button
await fixera.hirePro(c.id, { preferredDate: '2026-10-14', preferredWindow: 'morning' }); // then your Stripe checkout

// "Get AI Analysis" button (only if (await fixera.entitlement()).eligible)
await fixera.analyze(c.id);
const result = await fixera.waitForAnalysis(c.id);  // { case, assessment, steps, media, messages }
// Render result.assessment (reply, possible_causes, observations, safety, diy, cost_estimate, photo_requests)
// and result.steps in your own components.

// Guided DIY buttons in your UI
await fixera.stepResult(c.id, step.id, 'done');
await fixera.stepResult(c.id, step.id, 'need_help', 'Which nut is the slip nut?'); // then waitForAnalysis again
await fixera.sendMessage(c.id, 'The vent was blocked');
await fixera.outcome(c.id, 'resolved');

// Reopening later: fixera.getCase(caseId) restores photos, messages, steps and assessment.
```

What your UI must respect:
- When `assessment.safety.level` is `EMERGENCY`, show `assessment.safety.guidance` prominently and hide DIY.
- Show steps only when `assessment.diy.permitted` is true.
- Label cost as an estimate (`cost_estimate.disclaimer`).

## Verification map (guide §23 / §27)

| Acceptance test | Where it is proven |
| --- | --- |
| Actual image analyzed, not just text | `analysis.test.js` "clear photo…" asserts the uploaded bytes are in the model request. `providers.test.js` checks each provider's wire format. |
| Dark/blurry photo → request better evidence | `analysis.test.js` "dark or blurry photo…" |
| History influences assessment / no history → reduced context | `analysis.test.js` history tests |
| Two properties isolated, no cross-customer leakage | `access.test.js` |
| No HomeCare Pro → blocked server-side | `access.test.js` |
| Exposed wiring / gas → safety overrides | `analysis.test.js`, `safety.test.js` |
| Provider down → fallback or recoverable error | `analysis.test.js` failover, invalid output, all-fail |
| Close and reopen → case, media and messages restored | `lifecycle.test.js` (fresh app instance on the same DB) |
| Works inside a host app with its own login, via the headless client | `embed.test.js` |
| DIY fails → hire pro with data transferred; contractor completes → passport updated; inaccurate AI → correction retained | `lifecycle.test.js` end-to-end |
| Missing local cost → no invented price | `analysis.test.js` pricing test |
| Help with a step / photo mid-repair / unexpected condition | `lifecycle.test.js` |

## Known limitations and next steps

- **No live model evaluation yet.** Tests use scripted providers. Run `npm run eval -- --yes` with real keys and real photos, and grow the scenario set from consented, reviewed cases.
- **Starter content only.** The demo pricing rows and knowledge documents are placeholders. Production needs reviewed manuals, guides and regional pricing data.
- **Analysis jobs run in-process.** Use one instance or add a job queue before scaling horizontally. Interrupted jobs are marked recoverable on boot.
- **HEIC is rejected** with a clear message. Add server-side conversion if iOS uploads need it.
- **Stripe and dispatch are stand-ins.** The payment step and contractor assignment belong to the FixBridge platform; the admin `assign` route is a development stand-in.
- **Safety patterns are conservative.** They will sometimes remove a harmless step. Every change needs a test in `safety.test.js` and a `POLICY_VERSION` bump.
