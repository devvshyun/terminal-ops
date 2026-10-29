import { useQuery } from '@tanstack/react-query';
import { API_BASE, api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { SCOPE_LABEL } from '../lib/labels';
import type { PartnerScope } from '@terminal-ops/contracts';

/** 문서 경로 — api가 로그인 없이 내놓는다(decisions/0083) */
const DOC_PATH = '/partner/v1/openapi.json';

/** 이 화면이 읽는 OpenAPI의 부분(외부용 문서 모양 — api `partner-api/openapi.ts`) */
interface Schema {
  type?: string | string[];
  enum?: string[];
  description?: string;
  $ref?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
}
interface Parameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: Schema & { minimum?: number; maximum?: number; default?: number };
}
interface Operation {
  summary: string;
  'x-scope': PartnerScope;
  parameters: Parameter[];
  responses: Record<string, { description?: string; $ref?: string; content?: { 'application/json': { schema: Schema } } }>;
}
interface OpenApiDoc {
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, { description: string }> };
}

const refName = (ref: string) => ref.split('/').at(-1)!;
const typeText = (s: Schema): string => {
  if (s.$ref) return refName(s.$ref);
  if (s.type === 'array' && s.items) return `${typeText(s.items)}[]`;
  if (s.enum) return s.enum.join(' | ');
  if (s.oneOf) return s.oneOf.map(typeText).join(' | ');
  return Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? '');
};

/**
 * 연동 문서(보강 7, decisions/0083): api가 내놓는 OpenAPI(JSON)를 그대로 읽어 경로마다 그린다 — 화면이 문서를 따로 들고 있지 않다.
 * curl 예의 키 자리는 `<키>`(원문을 화면에 넣지 않는다).
 */
export function DocsPage() {
  const doc = useQuery({ queryKey: keys.docs, queryFn: () => api<OpenApiDoc>(DOC_PATH), staleTime: Infinity });
  if (doc.error) return <ErrorBox error={doc.error} />;
  if (!doc.data) return <p>불러오는 중…</p>;
  const { info, paths, components } = doc.data;
  return (
    <>
      <p className="eyebrow mono">
        OpenAPI {info.version} · <a href={`${API_BASE}${DOC_PATH}`}>JSON 받기</a>
      </p>
      <h1>{info.title}</h1>
      <p className="lead">{info.description}</p>
      <section className="panel auth">
        <h2>인증</h2>
        <p>
          둘 중 하나로 키를 보냅니다: <code>Authorization: Bearer &lt;키&gt;</code> 또는 <code>X-Api-Key: &lt;키&gt;</code>(둘 다 오면 Bearer). 키가 없거나 틀리거나
          폐기·만료되면 401, 키의 범위 밖이면 403입니다.
        </p>
      </section>
      {Object.entries(paths).flatMap(([path, ops]) =>
        Object.entries(ops).map(([method, op]) => <OperationDoc key={`${method} ${path}`} method={method.toUpperCase()} path={path} op={op} components={components} />),
      )}
    </>
  );
}

function OperationDoc({ method, path, op, components }: { method: string; path: string; op: Operation; components: OpenApiDoc['components'] }) {
  const ok = op.responses['200']?.content?.['application/json'].schema;
  const okSchema = ok?.$ref ? components.schemas[refName(ok.$ref)] : ok;
  const errors = Object.entries(op.responses).filter(([code]) => code !== '200');
  const sample = path.replace('{serialNo}', 'SN100-2610-00401').replace('{merchantCode}', 'GANGNAM-KIMBAP');
  return (
    <article className="op" aria-labelledby={`op-${method}-${path}`}>
      <h2 id={`op-${method}-${path}`} className="mono">
        <span className="method">{method}</span> {path}
      </h2>
      <p>
        {op.summary} · 범위 <code>{op['x-scope']}</code> ({SCOPE_LABEL[op['x-scope']] ?? op['x-scope']})
      </p>
      {op.parameters.length > 0 ? (
        <table aria-label="매개변수" className="doc-table">
          <thead>
            <tr>
              <th scope="col">이름</th>
              <th scope="col">자리</th>
              <th scope="col">모양</th>
              <th scope="col">설명</th>
            </tr>
          </thead>
          <tbody>
            {op.parameters.map((p) => (
              <tr key={p.name}>
                <td className="mono strong">{p.name}</td>
                <td>{p.in === 'path' ? '경로' : '쿼리'}</td>
                <td>
                  <span className="mono">
                    {typeText(p.schema)}
                    {p.schema.minimum !== undefined ? ` ${p.schema.minimum}~${p.schema.maximum}` : ''}
                  </span>
                  {p.schema.default !== undefined ? ` (기본 ${p.schema.default})` : ''}
                </td>
                <td>{p.description ?? (p.required ? '' : '선택')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {okSchema?.properties ? (
        <table aria-label="응답 필드" className="doc-table">
          <thead>
            <tr>
              <th scope="col">200 응답 필드</th>
              <th scope="col">모양</th>
              <th scope="col">설명</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(okSchema.properties).map(([name, s]) => (
              <tr key={name}>
                <td className="mono strong">{name}</td>
                <td className="mono">{typeText(s)}</td>
                <td>{s.description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="errors">
        오류:{' '}
        {errors.map(([code, r]) => (
          <span key={code} className="err">
            <span className="mono strong">{code}</span> {r.$ref ? components.responses[refName(r.$ref)]?.description : r.description}
          </span>
        ))}
      </p>
      <pre className="curl">curl -H 'Authorization: Bearer &lt;키&gt;' '&lt;api 주소&gt;{sample}'</pre>
    </article>
  );
}
