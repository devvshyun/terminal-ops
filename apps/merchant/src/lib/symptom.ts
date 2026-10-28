/** 서버 symptom 칸 길이(api OpenTicketDto @Length(1, 200)) */
export const SYMPTOM_MAX = 200;

/** 고른 증상과 메모를 "증상: 메모"로 잇는다(메모가 비면 증상만). 서버 칸은 글 하나다(decisions/0060) */
export function composeSymptom(choice: string, memo: string): string {
  const note = memo.trim();
  return note ? `${choice}: ${note}` : choice;
}

/** 이 증상을 고른 뒤 메모에 쓸 수 있는 글자 수(합쳐서 200자를 넘지 않게) */
export function memoMax(choice: string): number {
  return SYMPTOM_MAX - choice.length - 2;
}
