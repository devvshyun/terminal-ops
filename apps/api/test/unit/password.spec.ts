import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dummyPasswordHash, hashPassword, SCRYPT_PARAMS, verifyPassword } from '../../src/auth/password.js';

describe('비밀번호 해시 — scrypt (decisions/0051)', () => {
  it('형식은 scrypt$N$r$p$salt$hash이고, 같은 비밀번호도 소금이 달라 해시가 다르다', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 3 });
    expect(a).not.toBe(b);
  });

  it('맞는 비밀번호만 true', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('correct hors', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('저장된 비용 값으로 확인한다 — 비용을 올려도 옛 해시가 맞는다', async () => {
    const stored = await hashPassword('pw-1234567');
    const [, , r, p, salt] = stored.split('$');
    // 같은 소금·r·p에 N만 다르면 다른 키가 나온다 → 저장 형식의 N을 읽지 않으면 틀린다
    const changedN = ['scrypt', '16384', r, p, salt, stored.split('$')[5]].join('$');
    expect(await verifyPassword('pw-1234567', changedN)).toBe(false);
    expect(await verifyPassword('pw-1234567', stored)).toBe(true);
  });

  it('형식이 틀린 해시는 던지지 않고 false', async () => {
    for (const bad of ['', 'plain', 'bcrypt$1$2$3$a$b', 'scrypt$x$8$1$AAAA$BBBB', 'scrypt$16384$8$1$$BBBB', 'scrypt$16384$8$1$AAAA$short']) {
      expect(await verifyPassword('pw', bad)).toBe(false);
    }
  });

  it('비용을 올린 해시(N=2^16, 메모리 64MiB 넘음)도 저장된 값으로 확인한다 — maxmem을 저장된 비용에서 계산한다(Task 1 리뷰)', async () => {
    const salt = randomBytes(16);
    const key = scryptSync('pw-raised', salt, 64, { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const stored = ['scrypt', String(2 ** 16), '8', '1', salt.toString('base64'), key.toString('base64')].join('$');
    expect(await verifyPassword('pw-raised', stored)).toBe(true);
    expect(await verifyPassword('pw-other', stored)).toBe(false);
  });

  it('정수지만 scrypt가 거절하는 비용(N이 2의 거듭제곱 아님, 너무 큼)은 던지지 않고 false(Task 1 리뷰)', async () => {
    const tail = `${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`;
    for (const params of ['1000$8$1', `${2 ** 30}$8$1`, `16384$8$${2 ** 30}`]) {
      expect(await verifyPassword('pw', `scrypt$${params}$${tail}`)).toBe(false);
    }
  });

  it('가짜 해시는 한 번만 만들고 어떤 비밀번호와도 맞지 않는다', async () => {
    const first = await dummyPasswordHash();
    expect(await dummyPasswordHash()).toBe(first);
    expect(await verifyPassword('anything', first)).toBe(false);
  });
});
