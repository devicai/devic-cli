import type { ApiError } from './types.js';

export class DevicApiError extends Error {
  public statusCode: number;
  public errorType?: string;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'DevicApiError';
    this.statusCode = error.statusCode;
    this.errorType = error.error;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.errorType ?? `HTTP_${this.statusCode}`,
      statusCode: this.statusCode,
    };
  }
}

export class DevicCliError extends Error {
  public code: string;
  public exitCode: number;

  constructor(message: string, code: string, exitCode = 1) {
    super(message);
    this.name = 'DevicCliError';
    this.code = code;
    this.exitCode = exitCode;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
    };
  }
}
