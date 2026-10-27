import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * 비밀번호 해시(decisions/0051). node:crypto scrypt — 새 의존성·네이티브 빌드가 없다.
 * 비용은 OWASP 비밀번호 저장 권고표의 scrypt 한 줄(N=2^15, r=8, p=3). 이 PC에서 한 번에 약 140ms(계획 사전 검증).
 * 저장 형식: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>` — 비용을 올려도 옛 해시를 그 값으로 확인할 수 있다.
 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/**
 * scrypt 메모리는 약 128·N·r(지금 값 32MiB — node 기본 maxmem 32MiB에 딱 걸린다). maxmem은 저장된 비용에서 계산한다:
 * 비용을 올린 해시도 확인할 수 있게(고정 64MiB였을 때 N=2^16은 던졌다 — Task 1 리뷰). 다만 상한을 둔다 —
 * 저장된 값이 터무니없으면(N=2^30 등) 메모리를 잡지 않고 거절된다(verifyPassword는 false).
 */
const MAX_MEM_CAP = 256 * 1024 * 1024;
const maxmemFor = ({ N, r }: { N: number; r: number }) => Math.min(128 * N * r + 1024 * 1024, MAX_MEM_CAP);

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: maxmemFor(params) };
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 저장된 해시와 같은 비밀번호인지. 형식이 틀리거나 scrypt가 거절하는 비용이면 false(던지지 않는다). 비교는 timingSafeEqual */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  let actual: Buffer;
  try {
    actual = await derive(password, salt, { N, r, p });
  } catch {
    // 정수지만 scrypt가 거절하는 비용(N이 2의 거듭제곱이 아님, 메모리 상한 넘음) — 형식이 틀린 해시와 같게 false(Task 1 리뷰)
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * 없는 아이디로 로그인할 때도 비슷한 시간을 쓰게 하는 가짜 해시(응답 시간으로 계정 유무를 알아내지 못하게).
 * 처음 한 번 만들어 두고 이것과 비교한다(결과는 늘 false). AuthService가 앱이 뜰 때(onModuleInit) 미리 만든다 —
 * 첫 "없는 아이디" 로그인만 해시 두 번만큼 느려지면 그 차이로 아이디 유무가 보인다(Task 1 리뷰).
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
