export type ExecutionErrorCode = 'transient' | 'report' | 'configuration';

/** Only these model failures may use an explicitly configured supervisor. */
export class AgentExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, readonly code: ExecutionErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentExecutionError';
    this.retryable = code === 'transient';
  }
}

export function isEscalatableError(error: unknown): error is AgentExecutionError {
  return error instanceof AgentExecutionError && error.code !== 'configuration';
}
