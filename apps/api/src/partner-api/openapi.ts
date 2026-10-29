import { TerminalStatus } from '../terminal/terminal-status.js';

/**
 * 외부 업체용 연동 문서(OpenAPI 3.1, 보강 7, decisions/0083). 손으로 쓴다 — 외부용 경로가 둘뿐이고, 응답 모양은 contracts 타입이 정한다.
 * 코드와 어긋나면 테스트가 실패한다:
 * - 경로·메서드·scope(`x-scope`)는 `PartnerApiController`의 라우트 메타데이터와 같아야 한다(test/unit/partner-openapi.spec.ts)
 * - 응답 필드는 실제 응답의 키와 같아야 한다(test/partner-openapi.e2e.spec.ts)
 * 사내 API(`/admin` 등)는 넣지 않는다 — 이 문서는 로그인 없이 열린다.
 */
export const PARTNER_OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: '단말온 외부 연동 API',
    version: '1.0.0',
    description:
      '가맹점 단말기의 상태를 읽는 외부 업체용 API입니다. 키는 단말온 운영자가 개발자센터에서 발급합니다. 키마다 열린 범위(scope)가 있고, 범위 밖 경로는 403입니다.',
  },
  security: [{ bearer: [] }, { apiKey: [] }],
  paths: {
    '/partner/v1/terminals/{serialNo}': {
      get: {
        summary: '단말기 한 대의 상태',
        'x-scope': 'terminal-status:read',
        parameters: [{ name: 'serialNo', in: 'path', required: true, schema: { type: 'string' }, description: '단말기 시리얼 번호' }],
        responses: {
          '200': { description: '단말기', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerTerminal' } } } },
          '401': { $ref: '#/components/responses/Unauthenticated' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/partner/v1/merchants/{merchantCode}/terminals': {
      get: {
        summary: '가맹점의 단말기 목록',
        'x-scope': 'merchant-terminals:read',
        parameters: [
          { name: 'merchantCode', in: 'path', required: true, schema: { type: 'string' }, description: '가맹점 코드' },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 } },
          { name: 'size', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          '200': { description: '단말기 목록(쪽 단위)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerTerminalPage' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthenticated' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: '`Authorization: Bearer <키>`' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'Bearer를 쓸 수 없는 도구용. 둘 다 오면 Bearer를 쓴다' },
    },
    schemas: {
      PartnerTerminal: {
        type: 'object',
        required: ['serialNo', 'modelCode', 'status', 'merchantCode'],
        properties: {
          serialNo: { type: 'string' },
          modelCode: { type: 'string' },
          status: { type: 'string', enum: Object.values(TerminalStatus) },
          merchantCode: { type: ['string', 'null'], description: '배정 전이면 null' },
        },
      },
      PartnerTerminalPage: {
        type: 'object',
        required: ['items', 'total', 'page', 'size'],
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/PartnerTerminal' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          size: { type: 'integer' },
        },
      },
      Error: {
        type: 'object',
        required: ['statusCode', 'message'],
        properties: {
          statusCode: { type: 'integer' },
          code: { type: 'string', description: '오류 종류(UNAUTHENTICATED·FORBIDDEN 등). 없을 수 있다' },
          message: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          error: { type: 'string', description: 'HTTP 상태 이름(Not Found·Bad Request). 404·400에 붙는다' },
        },
      },
    },
    responses: {
      BadRequest: { description: '쿼리 값이 틀림(page·size 범위)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthenticated: {
        description: '키가 없거나, 맞지 않거나, 폐기·만료됨(이유를 나누지 않는다)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: { description: '이 키의 범위(scope) 밖', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NotFound: { description: '없는 시리얼·가맹점 코드', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
} as const;
