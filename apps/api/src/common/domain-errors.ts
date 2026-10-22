/** 허용되지 않은 상태 전이. HTTP 422로 바뀐다. */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}
