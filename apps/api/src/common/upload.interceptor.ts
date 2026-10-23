import { BadRequestException, type CallHandler, type ExecutionContext, mixin, type NestInterceptor, PayloadTooLargeException, type Type } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

type FileInterceptorOptions = NonNullable<Parameters<typeof FileInterceptor>[1]>;

/**
 * FileInterceptor와 같고, multer가 요청을 읽다 낸 오류에 code를 붙인다(decisions/0022).
 * - 파일 크기 초과(PayloadTooLargeException) → 413 FILE_TOO_LARGE
 * - 그 밖의 multer 400(다른 필드 이름, 파일 여러 개, 글자 필드, part 수 초과, 깨진 multipart) → 400 INVALID_FILE
 * multer 오류는 핸들러보다 먼저(파일을 다 받는 동안) 나므로, super.intercept의 await에서 잡히는 것만 바꾼다.
 * 핸들러·파라미터 데코레이터의 오류(작업자 헤더 400, MISSING_COLUMNS 등)는 next.handle()의 Observable로 흘러 여기서 건드리지 않는다.
 */
export function SingleFileInterceptor(fieldName: string, options: FileInterceptorOptions): Type<NestInterceptor> {
  const Base = FileInterceptor(fieldName, options);
  const limit = options.limits && typeof options.limits === 'object' ? options.limits.fileSize : undefined;
  const sizeText = limit ? `${Math.round((limit / 1024 / 1024) * 10) / 10}MB` : '제한';

  class UploadErrorInterceptor extends Base {
    async intercept(context: ExecutionContext, next: CallHandler) {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        if (error instanceof PayloadTooLargeException) {
          throw new PayloadTooLargeException({ statusCode: 413, code: 'FILE_TOO_LARGE', message: `파일은 ${sizeText}까지 받습니다.` });
        }
        if (error instanceof BadRequestException) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'INVALID_FILE',
            message: `${fieldName} 필드에 파일 하나만 보내세요(다른 필드 없이). 원인: ${error.message}`,
          });
        }
        throw error;
      }
    }
  }
  return mixin(UploadErrorInterceptor);
}
