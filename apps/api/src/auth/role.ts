/** 사람 계정의 역할(보강 2). 값은 contracts `Role`과 같다(common/contract-assertions.ts). 역할별 엔드포인트 표는 decisions/0052 */
export enum Role {
  ADMIN = 'ADMIN',
  OPERATOR = 'OPERATOR',
  MONITOR = 'MONITOR',
  FIELD = 'FIELD',
  MERCHANT = 'MERCHANT',
}
