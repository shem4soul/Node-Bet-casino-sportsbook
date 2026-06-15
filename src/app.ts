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
import { createLogger } from './config/logger';
import { runWithContext } from './lib/requestContext';
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

  // Request id: honour an upstream X-Request-Id (load balancer / client) or mint one,
  // echo it back, and open the async context every log line below reads from.
  app.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w.-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
    (req as any).id = id;
    res.setHeader('x-request-id', id);
    runWithContext({ requestId: id, ip: req.ip }, next);
  });

  app.use(
    pinoHttp({
      logger: createLogger('http'),
      genReqId: (req) => (req as any).id,
      quietReqLogger: true,
      autoLogging: { ignore: (req) => !env.LOG_PROBES && PROBES.has((req.url || '').split('?')[0]) },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res, ms) => `${req.method} ${routeOf(req)} ${res.statusCode} ${Math.round(ms)}ms`,
      customErrorMessage: (req, res, err) => `${req.method} ${routeOf(req)} ${res.statusCode} — ${err.message}`,
      customProps: (req, res) => ({ userId: (req as Request).user?.id, errorCode: (res as any).locals?.errorCode }),
      customAttributeKeys: { responseTime: 'durationMs' },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: String(req.url || '').split('?')[0],
          ip: req.remoteAddress,
          userAgent: req.headers?.['user-agent'],
        }),
        res: (res) => ({ statusCode: res.statusCode, contentLength: res.headers?.['content-length'] }),
      },
    })
  );
  const securityHeaders = helmet();
  app.use((req, res, next) => (req.path.startsWith('/docs') ? next() : securityHeaders(req, res, next)));
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

  if (env.DOCS_ENABLED) mountDocs(app);

  app.use('/api/v1', globalLimiter, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const PROBES = new Set(['/health', '/ready', '/metrics']);

/** Request path without the query string (query strings may carry tokens/PII). */
function routeOf(req: any): string {
  return (req.originalUrl || req.url || '').split('?')[0];
}

export function loadOpenApiSpec(): Record<string, any> | null {
  const specPath = path.join(__dirname, 'docs', 'openapi.yaml');
  if (!fs.existsSync(specPath)) return null;
  const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
  spec.info.version = spec.info.version || 'dev';
  spec.servers = [
    { url: `${env.APP_BASE_URL}/api/v1`, description: env.NODE_ENV },
    { url: '/api/v1', description: 'Same origin' },
  ];
  return spec;
}

/**
 * Swagger UI at /docs and the raw spec at /docs/openapi.json (+ .yaml).
 * Protected with HTTP Basic auth when DOCS_USERNAME/DOCS_PASSWORD are set.
 */
function mountDocs(app: express.Express) {
  const spec = loadOpenApiSpec();
  if (!spec) {
    createLogger('docs').warn('openapi.yaml not found — /docs disabled');
    return;
  }
  const guard: express.RequestHandler = (req, res, next) => {
    if (!env.DOCS_USERNAME || !env.DOCS_PASSWORD) return next();
    const expected = 'Basic ' + Buffer.from(`${env.DOCS_USERNAME}:${env.DOCS_PASSWORD}`).toString('base64');
    const given = req.headers.authorization || '';
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (ok) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="API docs"');
    res.status(401).send('Authentication required');
  };

  app.get('/docs/openapi.json', guard, (_req, res) => res.json(spec));
  app.get('/docs/openapi.yaml', guard, (_req, res) => res.type('text/yaml').send(YAML.stringify(spec)));
  app.use(
    '/docs',
    guard,
    // Swagger UI ships inline scripts/styles; relax CSP for this path only.
    helmet({ contentSecurityPolicy: false }),
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Naija Sportsbook API — Docs',
      customCss: '.swagger-ui .topbar { display: none }',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        tryItOutEnabled: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    })
  );
}

export default createApp;
