// 기록 색인(docs/index.md)을 만든다: 결정·트러블슈팅·실험 파일의 첫 줄 제목을 번호 순서로 모은다(decisions/0046).
// 사용(저장소 루트): node scripts/docs-index.mjs          → docs/index.md를 다시 쓴다
//                   node scripts/docs-index.mjs --check  → 지금 파일과 다르면 exit 1(기록을 더하고 색인을 잊었는지 확인)
// 의존성 없음(node 내장 모듈만). 파일 이름이 NNNN-로 시작하지 않거나 첫 줄이 "# NNNN. 제목"이 아니면 멈춘다.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const SECTIONS = [
  { dir: 'decisions', title: '결정 기록' },
  { dir: 'troubleshooting', title: '트러블슈팅' },
  { dir: 'experiments', title: '실험' },
];

function entries(dir) {
  return readdirSync(join(docs, dir))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      if (!/^\d{4}-/.test(file)) throw new Error(`${dir}/${file}: 파일 이름이 NNNN-으로 시작하지 않습니다.`);
      const first = readFileSync(join(docs, dir, file), 'utf8').split(/\r?\n/, 1)[0];
      const m = /^# (\d{4})\. (.+)$/.exec(first);
      if (!m || m[1] !== file.slice(0, 4)) throw new Error(`${dir}/${file}: 첫 줄이 "# ${file.slice(0, 4)}. 제목"이 아닙니다: ${first}`);
      // 링크는 파일 이름 그대로(한글·하이픈). 공백이 없어 인코딩하지 않아도 GitHub·VS Code에서 열린다
      return `- [${m[1]}](${dir}/${file}) ${m[2]}`;
    });
}

const body = [
  '# 기록 색인',
  '',
  '> 이 파일은 `node scripts/docs-index.mjs`가 만든다. 손으로 고치지 않는다(decisions/0046). 기록을 더한 뒤 다시 만들고, `--check`로 확인한다.',
  '',
  ...SECTIONS.flatMap(({ dir, title }) => {
    const list = entries(dir);
    return [`## ${title} (${list.length})`, '', ...list, ''];
  }),
].join('\n');

const target = join(docs, 'index.md');
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // 없으면 다르다
  }
  if (current.replace(/\r\n/g, '\n') !== body) {
    console.error('docs/index.md가 기록 파일과 다릅니다. node scripts/docs-index.mjs 로 다시 만드세요.');
    process.exit(1);
  }
  console.log('docs/index.md 최신');
} else {
  writeFileSync(target, body);
  console.log(`docs/index.md: ${SECTIONS.map(({ dir }) => `${dir} ${entries(dir).length}`).join(', ')}`);
}
