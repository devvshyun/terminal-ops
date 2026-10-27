/** "더 보기" 버튼. 다음 쪽이 없으면 "끝"을 보여 준다 */
export function MoreButton({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}) {
  if (!hasNextPage) return <p className="muted">끝</p>;
  return (
    <button type="button" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
      {isFetchingNextPage ? '불러오는 중' : '더 보기'}
    </button>
  );
}
