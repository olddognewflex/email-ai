import { PipeTransform, BadRequestException } from '@nestjs/common';
import { ZodType, ZodTypeDef } from 'zod';

/**
 * Validates and transforms with a Zod schema. The schema's input type is
 * left open so transforming schemas (string → boolean) are accepted.
 */
export class ZodValidationPipe<T> implements PipeTransform {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly schema: ZodType<T, ZodTypeDef, any>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.flatten());
    }
    return result.data;
  }
}
