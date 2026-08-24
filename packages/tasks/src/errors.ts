/**
 * Exit codes are part of the CLI's contract with scripts and agents: callers
 * branch on the code rather than parsing message text.
 */
export const ExitCode = {
  Success: 0,
  Internal: 1,
  Usage: 2,
  NotFound: 3,
  Conflict: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCode = "USAGE" | "NOT_FOUND" | "CONFLICT" | "INTERNAL";

const EXIT_BY_CODE: Record<ErrorCode, ExitCodeValue> = {
  USAGE: ExitCode.Usage,
  NOT_FOUND: ExitCode.NotFound,
  CONFLICT: ExitCode.Conflict,
  INTERNAL: ExitCode.Internal,
};

export class TaskError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCodeValue;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    this.exitCode = EXIT_BY_CODE[code];
    this.details = details;
  }

  /** Bad flags, unknown status name, malformed dependency ref. */
  static usage(message: string, details?: Record<string, unknown>): TaskError {
    return new TaskError("USAGE", message, details);
  }

  /** No `.tasks/` discovered, unknown task id. */
  static notFound(message: string, details?: Record<string, unknown>): TaskError {
    return new TaskError("NOT_FOUND", message, details);
  }

  /** Illegal transition, already claimed, lock contended, delete refused. */
  static conflict(message: string, details?: Record<string, unknown>): TaskError {
    return new TaskError("CONFLICT", message, details);
  }

  static internal(message: string, details?: Record<string, unknown>): TaskError {
    return new TaskError("INTERNAL", message, details);
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isTaskError(err: unknown): err is TaskError {
  return err instanceof TaskError;
}
