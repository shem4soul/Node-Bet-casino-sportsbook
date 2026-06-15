export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, statusCode = 400, code?: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code ?? defaultCode(statusCode);
    this.details = details;
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'BAD_GATEWAY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

export const badRequest = (msg: string, code?: string, details?: unknown) => new AppError(msg, 400, code, details);
export const unauthorized = (msg = 'Unauthorized', code?: string) => new AppError(msg, 401, code);
export const forbidden = (msg = 'Forbidden', code?: string) => new AppError(msg, 403, code);
export const notFound = (what = 'Resource') => new AppError(`${what} not found`, 404);
export const conflict = (msg: string, code?: string, details?: unknown) => new AppError(msg, 409, code, details);
