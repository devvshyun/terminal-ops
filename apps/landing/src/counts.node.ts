/**
 * 기록 수를 빌드 때 HTML에 채운다(decisions/0078 보탬). 스크립트가 없거나 실패해도 맞는 수가 보이게 —
 * index.html에는 손으로 숫자를 적지 않고 `data-count` 칸을 비워 두면 vite.config의 transformIndexHtml이 이 함수로 채운다.
 * Node에서만 쓴다(fs). 화면 스크립트의 recordCounts()(import.meta.glob)와 같은 수인지 content.test.ts가 본다.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export type RecordCounts = { decisions: number; troubleshooting: number; experiments: number };

const KINDS = ['decisions', 'troubleshooting', 'experiments'] as const;

export function countRecords(repoRoot: string): RecordCounts {
  const count = (kind: string) => readdirSync(resolve(repoRoot, 'docs', kind)).filter((f) => /^\d{4}-.*\.md$/.test(f)).length;
  return Object.fromEntries(KINDS.map((k) => [k, count(k)])) as RecordCounts;
}

/** `<dd data-count="decisions">…</dd>`의 안을 수로 바꾼다 */
export function fillCounts(html: string, counts: RecordCounts): string {
  return html.replace(/(data-count="(\w+)">)[^<]*</g, (all, open: string, kind: string) => (kind in counts ? `${open}${counts[kind as keyof RecordCounts]}<` : all));
}
