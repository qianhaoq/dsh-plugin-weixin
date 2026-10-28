/** Sanitized failures safe to print without response bodies or credentials. */
export class WeixinError extends Error {
  constructor(
    readonly code: 'NETWORK' | 'HTTP' | 'API' | 'AUTH_EXPIRED' | 'PROTOCOL' | 'STATE' | 'AGENT',
    readonly operation: string,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(`${operation}: ${message}`, options);
    this.name = 'WeixinError';
  }
}

/** Return a safe operational summary; unknown errors retain no arbitrary payload text.
 * @param error - Failure crossing the logging or message boundary.
 * @returns A summary with no model output, user message, token, or server response body.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) return `Account operation or cleanup failed: ${error.errors.map((cause: unknown) => describeError(cause)).join('; ')}`;
  return error instanceof WeixinError ? `${error.code}: ${error.message}` : 'Unexpected failure; inspect the local runtime and restart the channel.';
}
