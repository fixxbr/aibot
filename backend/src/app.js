import express from 'express';
import helmet from 'helmet';
import { createPricingService } from './fixera/pricing/pricingService.js';
import { createKnowledgeBase } from './fixera/knowledge/knowledgeBase.js';
import { createEmbedder } from './fixera/knowledge/embeddings.js';
import { createProviderRouter } from './fixera/providers/router.js';
import { createProvidersFromConfig } from './fixera/providers/registry.js';
import { createOrchestrator } from './fixera/orchestrator.js';
import { createHandoffService } from './fixera/handoff.js';
import { createCasesRouter } from './fixera/api/casesRouter.js';
import { createPassportRouter } from './fixera/api/passportRouter.js';
import { createContractorRouter } from './fixera/api/contractorRouter.js';
import { createAdminRouter } from './fixera/api/adminRouter.js';
import { createPlatformAdapter } from './platform/index.js';
import { authenticate, requireRole } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';

/**
 * Builds the Fixera Core service. Every dependency can be injected, which is how FixBridge
 * mounts it (own platform adapter) and how tests run it (embedded DB, scripted providers).
 */
export function createFixera({ db, config, storage, providers, platform, embedder }) {
  platform ||= createPlatformAdapter({ db, config });
  providers ||= createProvidersFromConfig(config);
  embedder = embedder === undefined ? createEmbedder(config) : embedder;
  const router = createProviderRouter({ db, providers, config });
  const knowledge = createKnowledgeBase({ db, embedder });
  const pricing = createPricingService({ db });
  const orchestrator = createOrchestrator({ db, router, storage, knowledge, pricing, config });
  const handoff = createHandoffService({ db, platform });
  return { db, config, storage, platform, router, knowledge, pricing, orchestrator, handoff };
}

export function createApp(fixera) {
  const { db, config, platform } = fixera;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.includes(origin)) {
        res.set({ 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', vary: 'Origin' });
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/healthz', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, providers: Object.keys(fixera.router.health()) });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const auth = authenticate(platform);
  app.use('/api/fixera/admin', auth, requireRole('admin'), createAdminRouter(fixera));
  app.use('/api/fixera/contractor', auth, requireRole('contractor'), createContractorRouter(fixera));
  app.use('/api/fixera', auth, requireRole('homeowner', 'admin', 'contractor'), createPassportRouter(fixera), createCasesRouter(fixera));

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
