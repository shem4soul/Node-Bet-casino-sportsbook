import { Queryable, pool, query } from '../config/db';
import type { Pagination } from '../lib/http';
import { createLogger } from '../config/logger';

const log = createLogger('audit');

export interface AuditEntry {
  actorId: number | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  // Mirrors every audit-table row into the log stream (event = "audit.<action>").
  log.info(
    {
      event: `audit.${e.action}`,
      actorId: e.actorId,
      entityType: e.entityType,
      entityId: e.entityId,
      metadata: e.metadata,
      ip: e.ip ?? undefined,
    },
    `Audit: ${e.action}${e.entityType ? ` ${e.entityType}#${e.entityId}` : ''}`
  );
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.actorId,
      e.action,
      e.entityType ?? null,
      e.entityId != null ? String(e.entityId) : null,
      JSON.stringify(e.metadata ?? {}),
      e.ip ?? null,
    ]
  );
}

export function listAuditLogs(p: Pagination & { action?: string; entityType?: string; entityId?: string }) {
  return query(
    pool,
    `SELECT a.*, u.username AS actor_username
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE ($1::text IS NULL OR a.action = $1)
       AND ($2::text IS NULL OR a.entity_type = $2)
       AND ($3::text IS NULL OR a.entity_id = $3)
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $4 OFFSET $5`,
    [p.action ?? null, p.entityType ?? null, p.entityId ?? null, p.limit, p.offset]
  );
}
