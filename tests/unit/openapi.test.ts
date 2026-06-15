import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

const SPEC = path.resolve(__dirname, '..', '..', 'src', 'docs', 'openapi.yaml');

/** Collects "METHOD /path" for every route mounted on the Express app. */
function expressRoutes(): string[] {
  const app: any = createApp();
  const out: string[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const src: string = layer.regexp.source.replace('^\\', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
        walk(layer.handle.stack, prefix + (src.startsWith('/') ? src : `/${src}`));
      }
    }
  };
  walk(app._router.stack, '');
  return out;
}

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3 document', async () => {
    await expect(SwaggerParser.validate(SPEC)).resolves.toBeTruthy();
  });

  it('has no keys created by unquoted commas in flow mappings', () => {
    // `{ description: Foo, bar }` silently becomes { description: 'Foo', bar: null } in YAML.
    const doc = YAML.parse(fs.readFileSync(SPEC, 'utf8'));
    const bad: string[] = [];
    const walk = (o: any, at: string) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (v === null && /[\s.()`]/.test(k)) bad.push(`${at} -> "${k}"`);
        walk(v, `${at}/${k}`);
      }
    };
    walk(doc, '#');
    expect(bad).toEqual([]);
  });

  it('documents every API route, and documents nothing that does not exist', async () => {
    const spec: any = await SwaggerParser.parse(SPEC);
    const normalise = (r: string) => r.replace(/\{[^}]+\}|:[A-Za-z]+/g, ':p').replace(/\/$/, '');
    const documented = new Set<string>();
    for (const [p, item] of Object.entries<any>(spec.paths)) {
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        if (!item[m]) continue;
        const root = item[m].servers?.[0]?.url === '/';
        documented.add(normalise(`${m.toUpperCase()} ${root ? '' : '/api/v1'}${p}`));
      }
    }
    const actual = new Set(
      expressRoutes()
        .filter((r) => r.includes('/api/v1') || /^\w+ \/(health|ready|metrics)$/.test(r))
        .map(normalise)
    );
    expect(
      [...actual].filter((r) => !documented.has(r)),
      'routes missing from openapi.yaml'
    ).toEqual([]);
    expect(
      [...documented].filter((r) => !actual.has(r)),
      'documented routes that do not exist'
    ).toEqual([]);
  });

  it('gives every operation a unique operationId, a summary, a tag and documented error responses', async () => {
    const spec: any = await SwaggerParser.parse(SPEC);
    const ids = new Set<string>();
    const problems: string[] = [];
    for (const [p, item] of Object.entries<any>(spec.paths)) {
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        const op = item[m];
        if (!op) continue;
        const name = `${m.toUpperCase()} ${p}`;
        if (!op.operationId) problems.push(`${name}: missing operationId`);
        else if (ids.has(op.operationId)) problems.push(`${name}: duplicate operationId ${op.operationId}`);
        ids.add(op.operationId);
        if (!op.summary) problems.push(`${name}: missing summary`);
        if (!op.tags?.length) problems.push(`${name}: missing tag`);
        const secured = op.security === undefined || op.security.some((s: any) => Object.keys(s).length > 0);
        const mustHave401 = secured && !(op.security ?? []).some((s: any) => Object.keys(s).length === 0);
        if (mustHave401 && !op.responses['401'] && !p.startsWith('/admin')) problems.push(`${name}: secured but no 401 documented`);
        if (p.startsWith('/admin') && !op.responses['403']) problems.push(`${name}: admin route without 403`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('is served at /docs/openapi.json', async () => {
    const { default: request } = await import('supertest');
    const res = await request(createApp()).get('/docs/openapi.json').expect(200);
    expect(res.body.info.title).toBe('Naija Sportsbook API');
    expect(res.body.servers[0].url).toMatch(/\/api\/v1$/);
    const ui = await request(createApp()).get('/docs/').expect(200);
    expect(ui.text).toContain('swagger-ui');
  });
});
