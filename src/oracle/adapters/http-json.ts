import { createHash } from "crypto";
import axios, { AxiosInstance, isAxiosError } from "axios";
import { ObservationEvidence } from "./source-adapter";

const EXCERPT_CHARS = 512;

export interface JsonResponse<T> {
  data: T;
  evidence: ObservationEvidence;
}

/** Failure kinds the source registry can distinguish for retry decisions. */
export type HttpJsonErrorKind = "http" | "timeout" | "network";

/**
 * Thrown when an upstream call fails. `kind` separates HTTP status failures
 * (non-2xx) from transport failures (timeout / network) so retry logic can
 * treat them differently.
 */
export class HttpJsonError extends Error {
  constructor(
    readonly kind: HttpJsonErrorKind,
    message: string,
    readonly status?: number,
    readonly bodyExcerpt?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HttpJsonError";
  }

  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "network" || (this.status ?? 0) >= 500;
  }
}

function classifyTransportError(err: unknown): HttpJsonError {
  const code = isAxiosError(err) ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return new HttpJsonError("timeout", `request timed out: ${message}`, undefined, undefined, err);
  }
  return new HttpJsonError("network", `request failed: ${message}`, undefined, undefined, err);
}

/**
 * Shared GET-JSON helper for adapters. Reads the body as text so the exact
 * bytes can be hashed for the evidence trail before parsing.
 */
export async function getJsonWithEvidence<T>(
  url: string,
  params: Record<string, string | number | boolean> | undefined,
  timeoutMs: number,
  http: AxiosInstance = axios,
): Promise<JsonResponse<T>> {
  const res = await http
    .get<string>(url, {
      params,
      timeout: timeoutMs,
      responseType: "text",
      transformResponse: (body: unknown) => body,
      validateStatus: () => true,
    })
    .catch((err: unknown) => {
      throw classifyTransportError(err);
    });
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  if (res.status < 200 || res.status >= 300) {
    throw new HttpJsonError(
      "http",
      `upstream responded ${res.status}: ${body.slice(0, EXCERPT_CHARS)}`,
      res.status,
      body.slice(0, EXCERPT_CHARS),
    );
  }
  const fullUrl = http.getUri({ url, params });
  const evidence: ObservationEvidence = {
    url: fullUrl,
    status: res.status,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
    excerpt: body.slice(0, EXCERPT_CHARS),
    capturedAt: Date.now(),
  };
  return { data: JSON.parse(body) as T, evidence };
}
