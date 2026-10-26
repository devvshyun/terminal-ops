/**
 * RFC 5987 ext-value(UTF-8''…)용 인코딩. encodeURIComponent는 ' ( ) * 를 남기는데, 이 글자들은 attr-char가 아니라서
 * 그대로 두면 엄격한 클라이언트가 filename*을 버리거나 잘못 자른다(Task 8 리뷰).
 */
export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 내려받기 헤더. filename은 ASCII 대체 이름(옛 클라이언트), filename*은 원래(한글) 이름 */
export function attachmentDisposition(fileName: string, asciiFallback: string): string {
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}
