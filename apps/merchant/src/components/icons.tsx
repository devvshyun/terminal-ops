/**
 * 탭의 선 아이콘(decisions/0070). 글자 옆에 붙는 장식이라 스크린 리더에는 숨긴다(링크 이름은 글자 그대로).
 * 색은 currentColor — 둘러싼 글자 색을 따른다. 현장 앱 `components/icons.tsx`와 모양 규칙이 같다(사본은 아니다 — 아이콘이 다르다).
 */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export const HomeIcon = () => <Icon d="M4 10l1.5-5h13L20 10M4 10v9h16v-9M4 10h16M9 19v-5h6v5" />;
export const ServiceIcon = () => <Icon d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />;
