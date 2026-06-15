import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { PG_CHECK_VIOLATION, PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION } from '../config/db';
import { AppError } from '../lib/errors';

const log = createLogger('errors');

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.locals.errorCode = 'NOT_FOUND';
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: (req as any).id } });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  const requestId = (req as any).id as string | undefined;
  let status = 500;
  let body: ErrorBody['error'] = { code: 'INTERNAL_ERROR', message: 'Internal server error' };

  if (err instanceof AppError) {
    status = err.statusCode;
    body = { code: err.code, message: err.message, details: err.details };
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { code: 'INVALID_JSON', message: 'Malformed JSON body' };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
  } else if (err?.code === PG_UNIQUE_VIOLATION) {
    status = 409;
    body = { code: 'DUPLICATE', message: 'Resource already exists' };
  } else if (err?.code === PG_FOREIGN_KEY_VIOLATION) {
    status = 400;
    body = { code: 'INVALID_REFERENCE', message: 'Referenced resource does not exist' };
  } else if (err?.code === PG_CHECK_VIOLATION) {
    status = 400;
    body = { code: 'CONSTRAINT_VIOLATION', message: 'Value violates a data constraint' };
  }

  // Surfaced on the HTTP access-log line (see customProps in app.ts).
  res.locals.errorCode = body.code;

  if (status >= 500) {
    log.error({ err, method: req.method, path: req.originalUrl }, 'Unhandled error');
    if (!env.isProduction && err?.message) body.details = { message: err.message, stack: err.stack };
  } else {
    // 4xx are already on the HTTP access line (with errorCode); security-relevant
    // ones (failed logins, bad webhook signatures, token reuse) are logged as events by services.
    log.debug({ code: body.code, status, path: req.originalUrl }, body.message);
  }

  res.status(status).json({ error: { ...body, requestId } });
}
