import { Request, Response, NextFunction } from 'express';
import { nodeEnv } from '../config/env';

export class AppError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  const statusCode: number = err.statusCode || 500;
  const body: { error: string; details?: unknown; stack?: string } = {
    error: err.message || 'Internal server error',
  };

  if (err.details) body.details = err.details;
  if (nodeEnv !== 'production' && statusCode === 500) body.stack = err.stack;

  if (statusCode === 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(statusCode).json(body);
}
