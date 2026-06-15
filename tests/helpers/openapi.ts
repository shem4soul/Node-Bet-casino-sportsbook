import path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Contract checking: validates real API responses against src/docs/openapi.yaml.
 *
 *  - the (method, path, status) must be documented,
 *  - the JSON body must satisfy the documented schema (types, enums, required),
 *  - and the body must not contain fields the docs don't mention
 *    (so the docs can't silently fall behind the code).
 */

const SPEC_PATH = path.resolve(__dirname, '..', '..', 'src', 'docs', 'openapi.yaml');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

let spec: any;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new WeakMap<object, ValidateFunction>();
const converted = new WeakMap<object, any>();
export const coverage = new Map<string, Set<number>>();
/** Mismatches collected by checkAgainstSpec (reported together at the end of a test). */
export const contractErrors: string[] = [];

interface Route {
  method: string;
  template: string;
  regex: RegExp;
  params: number;
  operation: any;
}
let routes: Route[] = [];

export async function loadSpec(): Promise<any> {
  if (spec) return spec;
  spec = await SwaggerParser.dereference(SPEC_PATH);
  for (const [template, item] of Object.entries<any>(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const rootLevel = Array.isArray(op.servers) && op.servers[0]?.url === '/';
      const prefix = rootLevel ? '' : '/api/v1';
      const pattern = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+');
      routes.push({
        method,
        template,
        regex: new RegExp(`^${prefix}${pattern}/?$`),
        params: (template.match(/\{/g) || []).length,
        operation: op,
      });
    }
  }
  // Literal segments win over path params (e.g. /x/featured before /x/{id}).
  routes = routes.sort((a, b) => a.params - b.params);
  return spec;
}

export function allOperations(): string[] {
  return routes.map((r) => `${r.method.toUpperCase()} ${r.template}`);
}

/** OpenAPI 3.0 `nullable: true` -> JSON Schema `anyOf [..., null]` (recursively, cycle-safe). */
function toJsonSchema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  if (converted.has(s)) return converted.get(s);
  const out: any = Array.isArray(s) ? [] : {};
  converted.set(s, out);
  for (const [k, v] of Object.entries(s)) {
    if (k === 'nullable' || k === 'example' || k === 'examples') continue;
    out[k] = typeof v === 'object' ? toJsonSchema(v) : v;
  }
  if (!Array.isArray(s) && s.nullable === true) {
    const inner = { ...out };
    for (const key of Object.keys(out)) delete out[key];
    out.anyOf = [inner, { type: 'null' }];
  }
  return out;
}

interface Declared {
  props: Record<string, any>;
  open: boolean;
}

function declared(schema: any): Declared {
  if (!schema || typeof schema !== 'object') return { props: {}, open: true };
  const parts = [schema, ...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  const props: Record<string, any> = {};
  let open = false;
  let anyProps = false;
  for (const p of parts) {
    if (p !== schema && (p.allOf || p.anyOf || p.oneOf)) {
      const d = declared(p);
      Object.assign(props, d.props);
      open ||= d.open;
      anyProps ||= Object.keys(d.props).length > 0;
    }
    if (p.properties) {
      Object.assign(props, p.properties);
      anyProps = true;
    }
    if (p.additionalProperties === true || (p.additionalProperties && typeof p.additionalProperties === 'object')) open = true;
  }
  // A schema that declares no properties at all (e.g. `details: {}`) is free-form.
  return { props, open: open || !anyProps };
}

function itemsSchema(schema: any): any {
  if (!schema) return undefined;
  if (schema.items) return schema.items;
  for (const p of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const i = itemsSchema(p);
    if (i) return i;
  }
  return undefined;
}

function undocumentedFields(schema: any, data: unknown, at: string, out: string[]): void {
  if (data === null || typeof data !== 'object' || !schema) return;
  if (Array.isArray(data)) {
    const items = itemsSchema(schema);
    data.slice(0, 5).forEach((d, i) => undocumentedFields(items, d, `${at}[${i}]`, out));
    return;
  }
  const { props, open } = declared(schema);
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (!(k in props)) {
      if (!open) out.push(`${at}.${k}`);
      continue;
    }
    undocumentedFields(props[k], v, `${at}.${k}`, out);
  }
}

export interface ResponseLike {
  status: number;
  body: any;
  text?: string;
  headers: Record<string, string>;
}

/** Like assertMatchesSpec, but records the mismatch instead of throwing. */
export function checkAgainstSpec(method: string, url: string, res: ResponseLike): void {
  try {
    assertMatchesSpec(method, url, res);
  } catch (err) {
    contractErrors.push((err as Error).message);
  }
}

/** Throws a descriptive error if the response doesn't match the documentation. */
export function assertMatchesSpec(method: string, url: string, res: ResponseLike): void {
  if (!spec) throw new Error('call loadSpec() first');
  const pathOnly = url.split('?')[0];
  const route = routes.find((r) => r.method === method.toLowerCase() && r.regex.test(pathOnly));
  if (!route) throw new Error(`Undocumented endpoint: ${method.toUpperCase()} ${pathOnly}`);
  const key = `${route.method.toUpperCase()} ${route.template}`;

  const response = route.operation.responses?.[String(res.status)] ?? route.operation.responses?.default;
  if (!response) {
    throw new Error(`${key} returned undocumented status ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  if (!coverage.has(key)) coverage.set(key, new Set());
  coverage.get(key)!.add(res.status);

  const contentType = String(res.headers['content-type'] || '');
  if (res.status === 204) {
    if (res.text) throw new Error(`${key} 204 must have an empty body`);
    return;
  }
  const media = response.content ?? {};
  if (contentType.startsWith('text/plain')) {
    if (!media['text/plain']) throw new Error(`${key} ${res.status} returned text/plain but docs don't declare it`);
    return;
  }
  const schema = media['application/json']?.schema;
  if (!schema) {
    if (contentType.includes('json') && res.text) throw new Error(`${key} ${res.status} returned JSON but no schema is documented`);
    return;
  }

  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(toJsonSchema(schema));
    validators.set(schema, validate);
  }
  if (!validate(res.body)) {
    const errs = (validate.errors ?? [])
      .slice(0, 8)
      .map((e) => `  ${e.instancePath || '(root)'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`);
    throw new Error(
      `${key} ${res.status} body does not match the documented schema:\n${errs.join('\n')}\nBody: ${JSON.stringify(res.body).slice(0, 600)}`
    );
  }
  const extra: string[] = [];
  undocumentedFields(schema, res.body, '$', extra);
  if (extra.length)
    throw new Error(
      `${key} ${res.status} returned fields missing from the docs: ${[...new Set(extra.map((e) => e.replace(/\[\d+\]/g, '[]')))].join(', ')}`
    );
}
