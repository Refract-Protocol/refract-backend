import { rpc } from "@stellar/stellar-sdk";

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const details = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const status = Number(details.status ?? details.statusCode);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;

  if (
    typeof details.code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(details.code)
  ) {
    return true;
  }

  return (
    typeof details.message === "string" &&
    /\b(timeout|timed out|network|connection reset|connection refused|fetch failed|temporarily unavailable|rate limit|too many requests|bad gateway|service unavailable|gateway timeout)\b/i.test(
      details.message
    )
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Wraps all Soroban RPC calls with bounded retries and endpoint failover.
 * Only transport/server-throttling failures are retried; contract and
 * request errors are returned immediately.
 */
export class SorobanRpcClient {
  private readonly servers: rpc.Server[];
  private activeServerIndex = 0;

  constructor(urls: string[]) {
    const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
    if (uniqueUrls.length === 0) {
      throw new Error("At least one Soroban RPC URL must be configured");
    }
    this.servers = uniqueUrls.map((url) => new rpc.Server(url));
  }

  async call<T>(operation: (server: rpc.Server) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      for (let offset = 0; offset < this.servers.length; offset++) {
        const serverIndex = (this.activeServerIndex + offset) % this.servers.length;
        try {
          const result = await operation(this.servers[serverIndex]);
          this.activeServerIndex = serverIndex;
          return result;
        } catch (error) {
          if (!isTransientRpcError(error)) throw error;
          lastError = error;
        }
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
        await wait(delay);
      }
    }

    throw lastError;
  }
}
