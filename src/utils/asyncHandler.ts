import { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps an async Express handler so rejected promises reach next(err)
// instead of crashing the process or hanging the request.
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return function wrapped(req: Request, res: Response, next: NextFunction) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
