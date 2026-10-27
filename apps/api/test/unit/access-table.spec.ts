import 'reflect-metadata';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { ACCESS_KEY, type Access } from '../../src/auth/access.js';

/**
 * 엔드포인트별 접근 규칙 표(decisions/0052). 앱의 모든 컨트롤러 핸들러를 모듈 메타데이터로 훑어 실제 규칙과 이 표를 맞춘다.
 * - 새 엔드포인트에 @Public/@Roles/@DeviceAuth를 달지 않으면 "규칙 없음"으로 실패한다(가드는 403으로 막는다 — 기본 거부).
 * - 규칙을 바꾸면(역할을 더하거나 빼면) 이 표도 같이 바꿔야 통과한다 — 권한 변경이 리뷰에서 보이게.
 * 값: 'public' | 'device' | 역할을 쉼표로(알파벳 순).
 */
const EXPECTED: Record<string, string> = {
  'GET /health': 'public',
  'POST /auth/login': 'public',
  'POST /auth/logout': 'ADMIN,FIELD,MERCHANT,MONITOR,OPERATOR',
  'GET /auth/me': 'ADMIN,FIELD,MERCHANT,MONITOR,OPERATOR',

  'POST /devices/heartbeats': 'device',
  'POST /devices/firmware-reports': 'device',

  'GET /terminals': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminals/:serialNo': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminals/:serialNo/history': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminals/:serialNo/inspections': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminal-models': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /inspection-items': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /purchase-orders': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /purchase-orders/:poNo': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /scans/:scanId': 'ADMIN,FIELD,MONITOR,OPERATOR',

  'GET /terminals/:serialNo/connectivity': 'ADMIN,MONITOR,OPERATOR',
  'GET /merchants': 'ADMIN,MONITOR,OPERATOR',
  'GET /inspections/stats': 'ADMIN,MONITOR,OPERATOR',
  'GET /purchase-orders/:poNo/reconciliation': 'ADMIN,MONITOR,OPERATOR',
  'GET /shipments/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /sync-runs': 'ADMIN,MONITOR,OPERATOR',
  'GET /service-tickets': 'ADMIN,MONITOR,OPERATOR',
  'GET /service-tickets/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /firmware-rollouts': 'ADMIN,MONITOR,OPERATOR',
  'GET /firmware-rollouts/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /anomaly-rules': 'ADMIN,MONITOR,OPERATOR',
  'GET /anomalies': 'ADMIN,MONITOR,OPERATOR',
  'GET /van-reconciliations': 'ADMIN,MONITOR,OPERATOR',
  'GET /van-reconciliations/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /reports/weekly': 'ADMIN,MONITOR,OPERATOR',
  'GET /reports/weekly/:weekStart': 'ADMIN,MONITOR,OPERATOR',
  'GET /reports/weekly/:weekStart/file': 'ADMIN,MONITOR,OPERATOR',
  'GET /dashboard/summary': 'ADMIN,MONITOR,OPERATOR',

  'POST /anomaly-scans': 'MONITOR,OPERATOR',
  'POST /van-reconciliations': 'MONITOR,OPERATOR',
  'POST /reports/weekly': 'MONITOR,OPERATOR',

  'POST /scans': 'FIELD,OPERATOR',
  'POST /terminals/:serialNo/inspections': 'FIELD,OPERATOR',

  'POST /terminals': 'OPERATOR',
  'POST /terminals/imports': 'OPERATOR',
  'POST /terminals/:serialNo/transitions': 'OPERATOR',
  'POST /terminals/:serialNo/allocations': 'OPERATOR',
  'POST /terminals/:serialNo/allocation-cancellations': 'OPERATOR',
  'POST /shipments': 'OPERATOR',
  'POST /purchase-orders': 'OPERATOR',
  'POST /purchase-orders/:poNo/close': 'OPERATOR',
  'POST /service-tickets': 'OPERATOR',
  'POST /service-tickets/:id/remote-checks': 'OPERATOR',
  'POST /service-tickets/:id/replacements': 'OPERATOR',
  'POST /service-tickets/:id/installations': 'OPERATOR',
  'POST /firmware': 'OPERATOR',
  'POST /firmware-rollouts': 'OPERATOR',
  'POST /firmware-rollouts/:id/pause': 'OPERATOR',
  'POST /firmware-rollouts/:id/resume': 'OPERATOR',
  'POST /firmware-rollouts/:id/abort': 'OPERATOR',
};

type ModuleLike = Type<unknown> | { module: Type<unknown>; imports?: unknown[]; controllers?: Type<unknown>[] };

/** 모듈 트리를 훑어 컨트롤러를 모은다(정적 @Module 메타데이터 + forRoot 같은 동적 모듈) */
function collectControllers(root: ModuleLike, seen = new Set<unknown>(), out = new Set<Type<unknown>>()): Set<Type<unknown>> {
  if (!root || seen.has(root)) return out;
  seen.add(root);
  const isDynamic = typeof root === 'object' && 'module' in root;
  const cls = isDynamic ? root.module : root;
  const imports = [...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) as ModuleLike[] | undefined) ?? []), ...(((isDynamic ? root.imports : undefined) ?? []) as ModuleLike[])];
  const controllers = [...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls) as Type<unknown>[] | undefined) ?? []), ...((isDynamic ? root.controllers : undefined) ?? [])];
  controllers.forEach((c) => out.add(c));
  for (const imported of imports) collectControllers(imported, seen, out);
  return out;
}

const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** 'GET /terminals/:serialNo' → 규칙 문자열(없으면 null) */
function routeTable(): Map<string, string | null> {
  const table = new Map<string, string | null>();
  const controllers = collectControllers(AppModule.forRoot({ workers: true, schedulers: true }));
  for (const controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '/';
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name] as unknown;
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '/';
      const key = `${RequestMethod[method]} ${join(base, path)}`;
      const access = Reflect.getMetadata(ACCESS_KEY, handler) as Access | undefined;
      table.set(key, !access ? null : access.kind === 'roles' ? [...access.roles].sort().join(',') : access.kind);
    }
  }
  return table;
}

describe('엔드포인트 접근 규칙 표 (decisions/0052)', () => {
  const actual = routeTable();

  it('모든 핸들러에 접근 규칙이 있다(없으면 기본 거부 403 — 달아야 한다)', () => {
    const missing = [...actual].filter(([, rule]) => rule === null).map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('실제 규칙이 결정 기록의 표와 같다(엔드포인트가 새로 생기거나 역할이 바뀌면 표도 바꾼다)', () => {
    expect(Object.fromEntries([...actual].sort(([a], [b]) => a.localeCompare(b)))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).sort(([a], [b]) => a.localeCompare(b))),
    );
  });

  it('훑기가 실제로 컨트롤러를 찾는다(표가 비어 통과하지 않게)', () => {
    expect(actual.size).toBe(Object.keys(EXPECTED).length);
    expect(actual.size).toBeGreaterThan(50);
  });
});
