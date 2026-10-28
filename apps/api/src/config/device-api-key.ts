/** 단말기 키(`X-Device-Key`, decisions/0055)의 최소 길이 */
export const DEVICE_API_KEY_MIN_LENGTH = 16;

/** 헤더에 그대로 넣을 수 있는 글자 — 공백·제어 문자 없는 ASCII(0x21~0x7E). device-sim `CONFIG_RULES.deviceKey`와 같은 규칙 */
const DEVICE_API_KEY_PATTERN = /^[\x21-\x7e]+$/;

/** `.env.example`의 자리표시자는 `change-me`로 시작한다. 이 값으로는 서버가 뜨지 않게 한다(복사만 하고 바꾸지 않은 경우, 최종 리뷰 Minor 2) */
const PLACEHOLDER_PREFIX = 'change-me';

/**
 * DEVICE_API_KEY 값을 읽는다. 시작할 때 던지는 경우(최종 리뷰 Minor 2·6):
 * 없음, 16자 미만, 헤더에 넣을 수 없는 글자(한글·공백·제어 문자), `.env.example` 자리표시자(`change-me…`)
 */
export function resolveDeviceApiKey(raw: string | undefined): string {
  if (!raw) throw new Error('환경변수 DEVICE_API_KEY가 없습니다. 저장소 루트 .env를 확인하세요.');
  if (raw.length < DEVICE_API_KEY_MIN_LENGTH) throw new Error(`환경변수 DEVICE_API_KEY는 ${DEVICE_API_KEY_MIN_LENGTH}자 이상이어야 합니다.`);
  if (!DEVICE_API_KEY_PATTERN.test(raw)) throw new Error('환경변수 DEVICE_API_KEY는 공백 없는 ASCII(0x21~0x7E)만 쓸 수 있습니다(X-Device-Key 헤더에 그대로 넣는다).');
  if (raw.startsWith(PLACEHOLDER_PREFIX)) {
    throw new Error(
      "환경변수 DEVICE_API_KEY가 .env.example의 자리표시자(change-me…)입니다. 임의의 값으로 바꾸세요(예: node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\").",
    );
  }
  return raw;
}
