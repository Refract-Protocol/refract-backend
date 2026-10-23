import { createHash } from "crypto";
import axios, { AxiosInstance } from "axios";
import { ObservationEvidence } from "./source-adapter";

const EXCERPT_CHARS = 512;

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
  http: AxiosInstance = axios,
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
