import type { ButtonHTMLAttributes } from 'react';
import { useOperator } from '../operator';

/** 쓰기 버튼: 작업자 이름이 없으면 꺼진다(서버도 X-Operator 없는 쓰기를 400으로 거절한다, decisions/0001) */
export function WriteButton({ disabled, title, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const operator = useOperator();
  return (
    <button
      type="button"
      {...rest}
      disabled={!operator || disabled}
      title={!operator ? '작업자 이름을 먼저 저장하세요' : title}
    />
  );
}
