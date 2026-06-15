import { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

/** Forwards async errors to Express' error handler. */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export function clientIp(req: Request): string | null {
  return req.ip || null;
}
