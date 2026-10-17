import http from "node:http";
import https from "node:https";
import {
  type AdapterEgressPolicy,
  DEFAULT_PROVIDER_ALLOWLIST,
  type DnsResolverFn,
  EgressDeniedError,
  type ResolvedAddress,
  defaultDnsResolver,
  validateAndResolveEgressTarget,
  validateFeedEgressConfig,
} from "./egress-guard.ts";

export interface HopRequestInput {
  url: URL;
  pinnedAddress: ResolvedAddress;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface HopResponseOutput {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type HopTransportFn = (input: HopRequestInput) => Promise<HopResponseOutput>;

export interface EgressTelemetrySink {
  onEgressDenied?(error: EgressDeniedError): void;
  logStructured?(entry: Record<string, unknown>): void;
}

export interface ProviderHttpClientOptions {
  policies?: Record<string, AdapterEgressPolicy>;
  resolver?: DnsResolverFn;
  transport?: HopTransportFn;
  telemetry?: EgressTelemetrySink;
  defaultTimeoutMs?: number;
  defaultMaxRedirects?: number;
  defaultMaxResponseBytes?: number;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ALLOWED_CONTENT_TYPES = ["application/json", "application/problem+json"];

/**
 * Default Node HTTP/HTTPS transport that pins the DNS-validated IP via a custom
 * `lookup` callback so a DNS-rebinding answer can never be substituted between
 * policy validation and socket connect.
 */
export const nodePinnedTransport: HopTransportFn = (input: HopRequestInput): Promise<HopResponseOutput> => {
  return new Promise((resolve, reject) => {
    const isHttps = input.url.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      input.url,
      {
        method: "GET",
        headers: {
          "accept-encoding": "identity",
          ...input.headers,
        },
        timeout: input.timeoutMs,
        lookup: (_hostname, _opts, cb) => {
          cb(null, input.pinnedAddress.address, input.pinnedAddress.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.byteLength;
          if (totalBytes > input.maxResponseBytes) {
            req.destroy(
              new EgressDeniedError({
                reason: "response_too_large",
                adapterId: "transport",
                url: input.url.toString(),
                detail: `${totalBytes} > ${input.maxResponseBytes}`,
                message: `Provider response exceeded ${input.maxResponseBytes} bytes`,
              })
            );
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Provider HTTP request timed out after ${input.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
};

export class ProviderHttpClient {
  private readonly policies = new Map<string, AdapterEgressPolicy>();
  private readonly resolver: DnsResolverFn;
  private readonly transport: HopTransportFn;
  private readonly telemetry?: EgressTelemetrySink;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRedirects: number;
  private readonly defaultMaxResponseBytes: number;
  private readonly deniedCounters = new Map<string, number>();

  constructor(options: ProviderHttpClientOptions = {}) {
    const initialPolicies = options.policies ?? DEFAULT_PROVIDER_ALLOWLIST;
    for (const policy of Object.values(initialPolicies)) {
      this.registerPolicy(policy);
    }
    this.resolver = options.resolver ?? defaultDnsResolver;
    this.transport = options.transport ?? nodePinnedTransport;
    this.telemetry = options.telemetry;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxRedirects = options.defaultMaxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.defaultMaxResponseBytes = options.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  registerPolicy(policy: AdapterEgressPolicy): void {
    validateFeedEgressConfig(policy);
    this.policies.set(policy.adapterId, policy);
  }

  getDeniedCount(adapterId?: string, reason?: string): number {
    if (adapterId && reason) {
      return this.deniedCounters.get(`${adapterId}:${reason}`) ?? 0;
    }
    let total = 0;
    for (const [k, v] of this.deniedCounters.entries()) {
      if (!adapterId || k.startsWith(`${adapterId}:`)) {
        total += v;
      }
    }
    return total;
  }

  private recordDenied(err: EgressDeniedError): never {
    const key = `${err.adapterId}:${err.reason}`;
    this.deniedCounters.set(key, (this.deniedCounters.get(key) ?? 0) + 1);
    this.telemetry?.onEgressDenied?.(err);
    this.telemetry?.logStructured?.({
      event: "oracle_egress_denied",
      adapterId: err.adapterId,
      reason: err.reason,
      url: err.url,
      detail: err.detail ?? null,
      at: new Date().toISOString(),
    });
    throw err;
  }

  async getJson<T = unknown>(
    adapterId: string,
    rawUrl: string,
    options: { headers?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<{ data: T; finalUrl: string; pinnedIp: string; redirectsFollowed: number }> {
    const policy = this.policies.get(adapterId);
    if (!policy) {
      this.recordDenied(
        new EgressDeniedError({
          reason: "host_not_allowlisted",
          adapterId,
          url: rawUrl,
          message: `No egress policy registered for adapter "${adapterId}"`,
        })
      );
    }

    const maxRedirects = policy.maxRedirects ?? this.defaultMaxRedirects;
    const maxResponseBytes = policy.maxResponseBytes ?? this.defaultMaxResponseBytes;
    const allowedContentTypes = policy.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    let currentUrl = rawUrl;
    let redirectsFollowed = 0;

    while (true) {
      let validated: Awaited<ReturnType<typeof validateAndResolveEgressTarget>>;
      try {
        validated = await validateAndResolveEgressTarget(currentUrl, policy, this.resolver);
      } catch (err) {
        if (err instanceof EgressDeniedError) {
          this.recordDenied(err);
        }
        throw err;
      }

      let response: HopResponseOutput;
      try {
        response = await this.transport({
          url: validated.parsedUrl,
          pinnedAddress: validated.pinnedAddress,
          headers: {
            accept: "application/json",
            ...(options.headers ?? {}),
          },
          timeoutMs,
          maxResponseBytes,
        });
      } catch (err) {
        if (err instanceof EgressDeniedError) {
          this.recordDenied(
            new EgressDeniedError({
              reason: err.reason,
              adapterId,
              url: currentUrl,
              detail: err.detail,
              message: err.message,
            })
          );
        }
        throw err;
      }

      if (response.body.byteLength > maxResponseBytes) {
        this.recordDenied(
          new EgressDeniedError({
            reason: "response_too_large",
            adapterId,
            url: currentUrl,
            detail: `${response.body.byteLength} > ${maxResponseBytes}`,
            message: `Response body size ${response.body.byteLength} exceeds cap ${maxResponseBytes}`,
          })
        );
      }

      if (response.statusCode >= 300 && response.statusCode < 400) {
        if (redirectsFollowed >= maxRedirects) {
          this.recordDenied(
            new EgressDeniedError({
              reason: "redirect_hop_limit_exceeded",
              adapterId,
              url: currentUrl,
              detail: `maxRedirects=${maxRedirects}`,
              message: `Redirect hop limit (${maxRedirects}) exceeded for adapter "${adapterId}"`,
            })
          );
        }

        const rawLocation = response.headers["location"];
        const locationHeader = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        if (!locationHeader) {
          this.recordDenied(
            new EgressDeniedError({
              reason: "redirect_location_missing",
              adapterId,
              url: currentUrl,
              message: `Redirect response ${response.statusCode} missing Location header`,
            })
          );
        }

        currentUrl = new URL(locationHeader, validated.parsedUrl).toString();
        redirectsFollowed += 1;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Upstream HTTP ${response.statusCode} from ${validated.parsedUrl.hostname}`);
      }

      const rawContentType = response.headers["content-type"];
      const contentTypeHeader = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();

      if (!allowedContentTypes.some((allowed) => contentTypeHeader === allowed.toLowerCase())) {
        this.recordDenied(
          new EgressDeniedError({
            reason: "disallowed_content_type",
            adapterId,
            url: currentUrl,
            detail: contentTypeHeader || "missing",
            message: `Disallowed response content-type "${contentTypeHeader || "missing"}" from "${validated.parsedUrl.hostname}"`,
          })
        );
      }

      const parsedJson = JSON.parse(response.body.toString("utf8")) as T;
      return {
        data: parsedJson,
        finalUrl: validated.parsedUrl.toString(),
        pinnedIp: validated.pinnedAddress.address,
        redirectsFollowed,
      };
    }
  }
}
