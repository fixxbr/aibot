# Plugging Fixera Engine into FixBridge

The engine is added as **one more provider behind the existing `api/ai.js` pipeline**. FixBridge keeps everything else unchanged:
- authorization, ownership, HomeCare eligibility and consent
- Property Passport context selection
- parsing and normalization, deterministic safety (`api/diy-safety.js`) and the evaluator
- pricing, persistence and every route and UI field

```
Browser → FixBridge route → auth / ownership / entitlement / consent
        → Property Passport context + knowledge
        → api/fixa/core.js → api/ai.js → [fixera-engine adapter] ──HMAC──▶ Fixera Engine → Gemini / OpenRouter / Anthropic / OpenAI
        → parsing / normalization / deterministic safety / evaluator      (on failure: original providers, unchanged)
        → FixBridge persistence, pricing, UI response
```

Replacing `api/fixera/index.js` alone would miss these callers, which import the legacy implementation directly:
- `api/managed-routes.js`: `assessRepair`, `extractDocument`
- `api/home-assistant-routes.js`: `complete`
- `api/homecare-pro-routes.js`: `complete`

Every one of them ends in `api/ai.js`. Registering the engine at the provider resolver (`api/ai.js:578`) therefore covers all of them with no route, alias or UI change.

## 1. Copy one file

`integration/fixbridge/api/fixera-engine-provider.js` → `api/fixera-engine-provider.js` in the FixBridge repo.

The file has no dependencies: it uses Node 22 `fetch` and `node:crypto`. It implements the existing adapter interface:

```js
analyze({ messages, temperature, maxTokens, json, signal })
  → { ok, provider: 'fixera-engine', model: '<upstream>:<model>', status, code, text, message, requestId, latencyMs, usage }
complete(...) / createCompletion(...)   // chat, Home Assistant, HomeCare Pro (json: false by default)
extractDocument(...)                    // equipment-label extraction (json: true)
isConfigured(), metadata(), model
health({ probe })                       // probe:false = no inference (current /api/fixera/health semantics)
```

The adapter never throws and never fabricates success. Failures return `{ ok: false, code }`.

## 2. Register it in the resolver (`api/ai.js`, around line 578)

The resolver currently builds an ordered list (Gemini → OpenRouter → Anthropic → OpenAI, with keyless providers removed and `FIXERA_AI_PROVIDER` / `AI_PRIMARY_PROVIDER` moved to the front). Wrap that list:

```js
import { withFixeraEngine } from './fixera-engine-provider.js';

// existing code that builds `providers` stays as is ...
providers = withFixeraEngine(providers);   // no-op unless FIXERA_AI_PROVIDER=fixera-engine
```

If the resolver also validates `FIXERA_AI_PROVIDER` against a fixed list of names, add `'fixera-engine'` to that list. Nothing else changes:
- The existing loop calls `analyze()` on the engine first.
- On `ok: false` it continues to Gemini/OpenRouter/Anthropic/OpenAI exactly as today. This is the tested rollback path.

Optional, for better traceability: where `api/ai.js` calls `analyze()`, pass `idempotencyKey: \`${assessmentInvocationId}:${attempt}\`` and `metadata: { invocation_id, case_type, case_id }`. Without them, the adapter derives a short-lived key from the request content, so a duplicate concurrent call (the outer `Promise.race` retry) joins the in-flight one instead of paying twice.

## 3. Environment variables

**FixBridge (Railway and Netlify functions)**, new names only. Existing names are untouched.

| Name | Purpose |
| --- | --- |
| `FIXERA_AI_PROVIDER=fixera-engine` | Turn the engine on. Unset it to roll back. |
| `FIXERA_ENGINE_URL` | Engine base URL, e.g. `https://fixera-engine.up.railway.app` |
| `FIXERA_ENGINE_SECRET` | HMAC signing secret. Generate it fresh; it is **not** `SESSION_SECRET`. |
| `FIXERA_ENGINE_TIMEOUT_MS` | Total deadline per call. Default `35000`, below `AI_FETCH_TIMEOUT_MS=38000`, so the adapter answers before the outer race. |
| `FIXERA_ENGINE_FALLBACK` | `original` (default) keeps the old providers behind the engine; `none` uses the engine only. |

**Engine service (separate Railway service)**

| Name | Purpose |
| --- | --- |
| `FIXERA_ENGINE_SECRETS` | Same secret as above. Comma-separate two values to rotate without downtime. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_CLOUD_API_KEY`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS` | Same names FixBridge uses |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_TIMEOUT_MS` | 〃 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_TIMEOUT_MS` | 〃 |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS` | 〃 |
| `FIXERA_AI_PROVIDER` / `AI_PRIMARY_PROVIDER` | Preferred upstream provider. Same order and defaults as FixBridge's resolver. |
| `AI_MAX_IMAGE_CHARS` | Per-image data-URL limit. Default `700000`, matching `api/repair-photos.js`. |
| `FIXERA_ENGINE_DATABASE_URL` | Optional. The engine's **own** small database (e.g. a separate Neon database) for durable idempotency and async jobs. Never FixBridge's `NEON_DATABASE_URL`. |
| `FIXERA_ENGINE_COMMIT` | Optional. Commit SHA to report; otherwise `RAILWAY_GIT_COMMIT_SHA` / `COMMIT_REF` / `git rev-parse`. |

The engine never receives `SESSION_SECRET`, `NEON_DATABASE_URL`/`DATABASE_URL`, or any FixBridge user token.

## 4. Deploy the engine (Railway)

- **New service** from this repository. Root directory: `backend`. Build command: `npm ci`. Start command: `npm run start:engine`. Health check path: `/v1/health`. Node 22+.
- **After deploy:**
  - `GET /v1/health` is public. It shows the **commit SHA** and the last real inference, which stays `null` until one happens.
  - `adapter.health()` calls signed `GET /v1/status`: configuration only, no inference.
  - `adapter.health({ probe: true })` calls signed `POST /v1/probe`. This is **one real, billed inference per provider** with a red/blue test image, and it returns `vision_verified: true` only if the model named those colours.

  This addresses the gap that today's health response does not attest the commit or successful inference.
- **Database vendor:** the status response reports `database.vendor_evidence`, such as the hostname suffix and Neon-specific server settings, plus `vendor_verified` only when both are observed. A label alone is not treated as proof.

## 5. Engine API (contract `2026-10-01`)

`POST /v1/infer`
- **Headers:** `X-Fixera-Timestamp` (ms), `X-Fixera-Signature: v1=hex(HMAC_SHA256(secret, "<timestamp>.<raw body>"))`, optional `Idempotency-Key`, optional `Prefer: respond-async`.
- **Body:**
  ```json
  { "contract_version": "2026-10-01", "task": "assessment|chat|extract|second_opinion|other",
    "messages": [{ "role": "system|user|assistant", "content": "text or [{type:'text'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,...'}}]" }],
    "json": true, "temperature": 0.2, "max_tokens": 1500, "deadline_ms": 34500,
    "metadata": { "invocation_id": "...", "case_type": "managed_job", "case_id": 501 } }
  ```
- **Success:** `{ ok: true, text, provider, model, usage, vision_used, image_count, latency_ms, attempts: [...], request_id, cached }`
- **Failure:** `{ ok: false, code, message, retryable, attempts, request_id }`

| Code | HTTP | Adapter `code` |
| --- | --- | --- |
| `INVALID_REQUEST`, `INVALID_IMAGE`, `TOO_MANY_IMAGES`, `UNSUPPORTED_CONTRACT` | 400 | `FIXERA_ENGINE_<CODE>` |
| `IMAGE_TOO_LARGE` | 413 | 〃 |
| `UNAUTHORIZED` | 401 | 〃 |
| `IN_PROGRESS` | 409 | adapter waits for the running call |
| `IDEMPOTENCY_KEY_REUSED` | 422 | 〃 |
| `RATE_LIMITED` | 429 | 〃 |
| `CANCELLED` | 499 | `FIXERA_ENGINE_CANCELLED` |
| `PROVIDER_FAILED`, `INVALID_MODEL_OUTPUT` | 502 | 〃 (retryable) |
| `NO_PROVIDER_CONFIGURED`, `NO_VISION_PROVIDER` | 503 | 〃 |
| `DEADLINE_EXCEEDED` | 504 | 〃 |
| (engine down / network) | – | `FIXERA_ENGINE_UNREACHABLE`, `FIXERA_ENGINE_TIMEOUT` |

Map any `FIXERA_ENGINE_*` failure to the existing `AI_ASSESSMENT_TEMPORARILY_UNAVAILABLE` wherever `api/ai.js` currently maps provider failures.

**What the engine adds over the current adapters:**
- **One total deadline.** Retries and fallbacks share it, and the per-attempt timeout is capped by what remains.
- **Real cancellation.** A caller abort or disconnect aborts the upstream HTTP request; it is not just a race.
- **Vision-aware routing.** Images never go to a text-only model. If no vision provider exists, the result is `NO_VISION_PROVIDER` rather than a text-only "analysis".
- **JSON validation.** Unparseable output gets one retry on the same provider, then falls back.
- **Image checks** on top of `repair-photos.js`: the decoded bytes must match the declared JPEG/PNG/WEBP type.
- **Idempotency.** The same key and body replay the stored result. A different body under the same key is rejected. A failed key can be retried.
- **Async jobs** for the assessment worker (`Prefer: respond-async` → `202`, then poll `GET /v1/infer/:key`). With `FIXERA_ENGINE_DATABASE_URL` they survive restarts, and interrupted runs become retryable failures.
- **Privacy.** Prompts and images are never stored or logged, only IDs, counts, provider, model, latency and codes.

## 6. Cutover and rollback

1. Deploy the engine. Run `adapter.health({ probe: true })` from a FixBridge shell or admin route and confirm `inference_verified`.
2. On a preview/staging environment, set `FIXERA_AI_PROVIDER=fixera-engine`, `FIXERA_ENGINE_URL` and `FIXERA_ENGINE_SECRET`.
3. Run the existing suites unchanged (`node --test` over `api/**/*.test.js`, including the nested provider-chain/provider-failure tests). All UI-consumed fields come from FixBridge's own parsing, so they should pass.
4. Run a separately authorized real-model quality pass on fixture cases. Compare the engine's assessments with the current provider path before production.
5. **Production:** set the same three variables.
6. **Rollback:** unset `FIXERA_AI_PROVIDER`, or set it back to `gemini`. No deploy is needed. With `FIXERA_ENGINE_FALLBACK=original`, a failing engine already falls through to the original providers on every call.

## 7. Verified here vs. still to verify

Verified in this repository (`backend/test/engine.test.js` and `providers.test.js`, against an embedded database and a real PostgreSQL 16 server):
- adapter response shape
- exact image bytes forwarded
- image validation
- HMAC (missing, wrong secret, stale, tampered body)
- contract version rejection
- vision routing
- JSON retry and fallback
- outage fallback and the all-fail path with no fabricated text
- total deadline with upstream abort
- caller cancellation with upstream abort
- duplicate concurrent calls sharing one model call
- idempotent replay, conflict and retry
- async jobs
- durable store across restart
- health/status/probe semantics
- resolver opt-in and rollback
- wire format of each provider's `complete()`

Not verified, because there was no access to the FixBridge repository or credentials:
- the exact resolver code at `api/ai.js:578` and its existing tests
- real model quality
- Railway settings and the deployed Node version

The gaps listed in your audit (§14) are FixBridge route behaviours and stay FixBridge's to fix. The engine does not change them:
- `/api/public/jobs` HomeCare gate
- handoff ownership
- feedback ownership
- chat without a job skipping hazard checks
- managed-before-pending ID lookup
