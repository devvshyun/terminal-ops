import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ACCESS_KEY, type Access } from '../../src/auth/access.js';
import { PARTNER_OPENAPI } from '../../src/partner-api/openapi.js';
import { PartnerApiController } from '../../src/partner-api/partner-api.controller.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';

/** 연동 문서(손으로 쓴 OpenAPI)가 외부용 컨트롤러와 어긋나지 않는다(보강 7, decisions/0083) */
describe('외부 업체 연동 문서 ↔ PartnerApiController', () => {
  /** 컨트롤러의 라우트를 `GET /partner/v1/terminals/{serialNo} terminal-status:read` 모양으로 */
  const routes = () => {
    const base = Reflect.getMetadata(PATH_METADATA, PartnerApiController) as string;
    return Object.getOwnPropertyNames(PartnerApiController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = PartnerApiController.prototype[name as keyof PartnerApiController] as object;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        const access = Reflect.getMetadata(ACCESS_KEY, handler) as Access;
        const full = `/${base}/${path}`.replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}');
        return `${method} ${full} ${access.kind === 'partner' ? access.scope : access.kind}`;
      })
      .sort();
  };

  const documented = () =>
    Object.entries(PARTNER_OPENAPI.paths)
      .flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => `${method.toUpperCase()} ${path} ${(op as { 'x-scope': string })['x-scope']}`))
      .sort();

  it('경로·메서드·scope가 같다(한쪽에만 있으면 실패)', () => {
    expect(routes()).toHaveLength(2);
    expect(documented()).toEqual(routes());
  });

  it('경로 변수는 parameters에 path로 적혀 있다', () => {
    for (const [path, ops] of Object.entries(PARTNER_OPENAPI.paths)) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const op of Object.values(ops)) {
        const params = (op as { parameters: readonly { name: string; in: string }[] }).parameters.filter((p) => p.in === 'path').map((p) => p.name);
        expect(params, path).toEqual(names);
      }
    }
  });

  it('상태 enum은 api의 TerminalStatus 그대로', () => {
    expect(PARTNER_OPENAPI.components.schemas.PartnerTerminal.properties.status.enum).toEqual(Object.values(TerminalStatus));
  });
});
