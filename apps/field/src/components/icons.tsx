/**
 * 탭·큰 버튼의 선 아이콘(decisions/0070). 글자 옆에 붙는 장식이라 스크린 리더에는 숨긴다(링크 이름은 글자 그대로).
 * 색은 currentColor — 둘러싼 글자 색을 따른다.
 */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export const HomeIcon = () => <Icon d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />;
export const ScanIcon = () => <Icon d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 9v6M11 9v6M14 9v6M17 9v6" />;
export const InspectIcon = () => <Icon d="M8 4h8v3H8zM6 5.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-1M9 13.5l2 2 4-4" />;
