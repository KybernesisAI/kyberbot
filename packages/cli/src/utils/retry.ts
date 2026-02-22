/**
 * KyberBot — Retry Utility
 *
 * Provides exponential backoff retry logic for external API calls.
 */

export interface RetryOptions {
  retries?: number;
  delay?: number;
  backoff?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    delay = 1000,
    backoff = 2,
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === retries) {
        throw lastError;
      }

      onRetry?.(lastError, attempt);

      const waitTime = delay * Math.pow(backoff, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError!;
}

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryOptions?: RetryOptions
): Promise<Response> {
  return withRetry(async () => {
    const response = await fetch(url, options);
    if (!response.ok && response.status >= 500) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response;
  }, retryOptions);
}
