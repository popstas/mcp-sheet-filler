export interface Field {
  name: string;
  description?: string;
  auto?: boolean;
  instructions?: string;
  type?: string;
  example?: string;
}

export interface DataObject {
  name: string;
  values: Record<string, string>;
}

export type SaveStatus =
  | 'saved'
  | 'skipped_already_set'
  | 'rejected_unknown_field'
  | 'rejected_invalid_type';

export type ErrorCode =
  | 'backend_not_configured'
  | 'field_already_exists'
  | 'field_not_found'
  | 'object_already_exists'
  | 'object_not_found'
  | 'invalid_argument'
  | 'storage_error'
  | 'unauthorized'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'rate_limited';

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class FillerError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'FillerError';
  }

  toJSON(): AppError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
