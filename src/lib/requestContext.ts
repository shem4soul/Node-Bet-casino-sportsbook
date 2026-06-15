import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context carried through every async call made while handling
 * a request. The logger reads it (see config/logger.ts `mixin`) so any log
 * line written anywhere in the call stack — services, repositories — is
 * automatically tagged with the request id and the authenticated user.
 */
export interface RequestContext {
  requestId?: string;
  userId?: number;
  role?: string;
  ip?: string;
  /** Set by background jobs instead of requestId. */
  job?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Adds fields (e.g. userId after authentication) to the current request's context. */
export function setContext(fields: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}
