import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express, { Request } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { env } from './config/env';
import { logger } from './config/logger';
import { checkDatabase } from './config/db';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { globalLimiter } from './middleware/rateLimit';
import { metricsMiddleware, registry } from './middleware/metrics';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Needed for correct req.ip (rate limiting, Paystack IP whitelist) behind a proxy/LB.
  app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => ['/health', '/ready', '/metrics'].includes(req.url || '') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    })
  );
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : !env.isProduction,
      credentials: true,
      exposedHeaders: ['x-request-id', 'RateLimit', 'RateLimit-Policy'],
    })
  );
  app.use(compression());
  app.use(metricsMiddleware);

  // Keep the exact raw bytes for webhook signature verification — re-serialising
  // parsed JSON can change key order/whitespace and silently break the HMAC.
  app.use(
    express.json({
      limit: '100kb',
      verify: (req: Request, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    })
  );

  // ---- Operational endpoints (outside /api, not rate limited) ----
  app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/ready', async (_req, res) => {
    const db = await checkDatabase();
    res.status(db ? 200 : 503).json({ status: db ? 'ready' : 'unavailable', database: db });
  });
  app.get('/metrics', async (req, res) => {
    if (env.METRICS_TOKEN && req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
      res.status(401).end();
      return;
    }
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  if (env.DOCS_ENABLED) {
    const specPath = path.join(__dirname, 'docs', 'openapi.yaml');
    if (fs.existsSync(specPath)) {
      const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
      spec.servers = [{ url: `${env.APP_BASE_URL}/api/v1` }];
      app.get('/docs/openapi.json', (_req, res) => res.json(spec));
      app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Sportsbook API' }));
    }
  }

  app.use('/api/v1', globalLimiter, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
