import { NextFunction, Request, Response } from 'express';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'sportsbook_' });

const httpDuration = new client.Histogram({
  name: 'sportsbook_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const betsPlaced = new client.Counter({
  name: 'sportsbook_bets_placed_total',
  help: 'Bet slips placed',
  labelNames: ['bet_type'],
  registers: [registry],
});

export const depositsCredited = new client.Counter({
  name: 'sportsbook_deposits_credited_total',
  help: 'Deposits credited to wallets',
  registers: [registry],
});

export const jobRuns = new client.Counter({
  name: 'sportsbook_job_runs_total',
  help: 'Background job executions',
  labelNames: ['job', 'outcome'],
  registers: [registry],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    // Use the matched route pattern (not the raw URL) to keep label cardinality low.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}
