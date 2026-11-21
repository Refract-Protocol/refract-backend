import { createHash } from "crypto";
import axios, { AxiosInstance } from "axios";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { ObservationEvidence } from "./source-adapter";

const EXCERPT_CHARS = 512;

/**
 * Process-wide keep-alive agents so consecutive oracle fetches reuse the same
 * socket instead of paying a TLS handshake per request. Created lazily on first
 * use and closed by `closeHttpAgents()` on shutdown.
 */
let httpAgent: HttpAgent | undefined;
let httpsAgent: HttpsAgent | undefined;

function getHttpAgent(): HttpAgent {
  if (!httpAgent) {
    httpAgent = new HttpAgent({ keepAlive: true });
  }
  return httpAgent;
}

function getHttpsAgent(): HttpsAgent {
  if (!httpsAgent) {
    httpsAgent = new HttpsAgent({ keepAlive: true });
  }
  return httpsAgent;
}

/** Shared axios client bound to the keep-alive agents. */
const sharedHttp: AxiosInstance = axios.create({
  httpAgent: getHttpAgent(),
  httpsAgent: getHttpsAgent(),
});

/**
 * Close the shared keep-alive agents. Safe to call more than once; a later
 * request recreates them.
 */
export function closeHttpAgents(): void {
  httpAgent?.destroy();
  httpsAgent?.destroy();
  httpAgent = undefined;
  httpsAgent = undefined;
}

export interface JsonResponse<T> {
  data: T;
  evidence: ObservationEvidence;
}

/**
 * Shared GET-JSON helper for adapters. Reads the body as text so the exact
 * bytes can be hashed for the evidence trail before parsing.
 */
export async function getJsonWithEvidence<T>(
  url: string,
  params: Record<string, string | number | boolean> | undefined,
  timeoutMs: number,
  http: AxiosInstance = sharedHttp,
): Promise<JsonResponse<T>> {
  const res = await http.get<string>(url, {
    params,
    timeout: timeoutMs,
    responseType: "text",
    transformResponse: (body: unknown) => body,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
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
