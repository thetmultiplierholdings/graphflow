import type { JsonValue } from '../../domain/json/JsonValue.js';

// Local mirror of @multiplier/lib-shared-errors — same class names and call shapes, so the
// monorepo move is an import-specifier swap. Do not add other error classes anywhere.
export abstract class BaseError extends Error {
  protected constructor(message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends BaseError {
  constructor(
    message: string,
    readonly field?: string,
    cause?: Error
  ) {
    super(message, cause);
  }
}

export class NotFoundError extends BaseError {
  constructor(
    message: string,
    readonly resourceType?: string,
    readonly resourceId?: string | number,
    cause?: Error
  ) {
    super(message, cause);
  }
}

export class RuntimeError extends BaseError {
  constructor(
    message: string,
    readonly context?: Record<string, JsonValue>,
    cause?: Error
  ) {
    super(message, cause);
  }
}

const toError = (value: Error): Error => (value instanceof Error ? value : new Error(String(value)));

// Re-throws BaseError subclasses unchanged; converts anything else to Error and hands it to the
// caller's conversion function, then throws the resulting BaseError.
export function convertToStandardErrorAndThrow(error: Error, convert: (err: Error) => BaseError): never {
  if (error instanceof BaseError) {
    throw error;
  }
  throw convert(toError(error));
}

// Re-throws BaseError subclasses immediately; returns everything else converted to Error.
export function throwIfStandardError(error: Error): Error {
  if (error instanceof BaseError) {
    throw error;
  }
  return toError(error);
}

export const errorMessage = (error: Error): string => (error instanceof Error ? error.message : String(error));

export const isSqliteConstraintError = (error: Error): boolean => {
  const code: string | undefined = Reflect.get(error, 'code');
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
};
