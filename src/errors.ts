import type {
  ApiError,
  IntegrationSetupRequired,
  InvalidSubagentRef,
} from './types.js';

export class DevicApiError extends Error {
  public statusCode: number;
  public errorType?: string;
  public field?: string;
  public invalidSubagents?: InvalidSubagentRef[];
  public setupRequired?: IntegrationSetupRequired;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'DevicApiError';
    this.statusCode = error.statusCode;
    this.errorType = error.error;
    this.field = error.field;
    this.invalidSubagents = error.invalidSubagents;
    this.setupRequired = error.setupRequired;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.setupRequired?.code ?? this.errorType ?? `HTTP_${this.statusCode}`,
      statusCode: this.statusCode,
      ...(this.field ? { field: this.field } : {}),
      ...(this.invalidSubagents
        ? { invalidSubagents: this.invalidSubagents }
        : {}),
      // The fields the app is waiting for, so a non-interactive caller can act
      // on the failure instead of only reporting it.
      ...(this.setupRequired
        ? {
            authScheme: this.setupRequired.authScheme,
            stage: this.setupRequired.stage,
            missingFields: this.setupRequired.fields.map((f) => ({
              name: f.name,
              label: f.label,
              secret: f.secret,
              description: f.description,
            })),
            ...(this.setupRequired.guideUrl
              ? { guideUrl: this.setupRequired.guideUrl }
              : {}),
          }
        : {}),
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
