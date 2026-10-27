import { ValidateBy, buildMessage, type ValidationOptions } from 'class-validator';

/**
 * 'YYYY-MM-DD'이고 달력에 있는 날짜인지. 모양만 맞는 2026-13-45·2026-02-30은 거른다
 * (그대로 MySQL date 비교에 넘기면 500이 났다 — Task 3 리뷰). Date.UTC로 만든 날짜를 다시 문자열로 바꿔 같은지 본다.
 */
export function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isCalendarDate',
      validator: {
        validate: (value) => isCalendarDate(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property는 달력에 있는 날짜(YYYY-MM-DD)입니다.`, options),
      },
    },
    options,
  );
}
