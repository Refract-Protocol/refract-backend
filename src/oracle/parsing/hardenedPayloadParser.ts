export type PayloadValidationErrorCode =
  | "INVALID_CONTENT_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "MALFORMED_JSON"
  | "MAX_NESTING_DEPTH_EXCEEDED"
  | "MAX_ARRAY_LENGTH_EXCEEDED"
  | "UPSTREAM_ERROR_ENVELOPE"
  | "SCHEMA_FIELD_VALIDATION_FAILED";

export interface TypedPayloadValidationError {
  providerId: string;
  schemaVersion: string;
  code: PayloadValidationErrorCode;
  failedPath: string;
  message: string;
}

export type ProviderPayloadParseResult<T> =
  | { ok: true; providerId: string; schemaVersion: string; data: T }
  | { ok: false; error: TypedPayloadValidationError };

export interface HardenedParserLimits {
  maxPayloadBytes?: number;
  maxNestingDepth?: number;
  maxArrayLength?: number;
}

export interface ProviderPayloadValidator<T> {
  readonly providerId: string;
  readonly schemaVersion: string;
  validateParsedObject(
    root: Record<string, unknown>
  ): { ok: true; data: T } | { ok: false; failedPath: string; message: string };
}

export class HardenedProviderPayloadParser {
  public static parseProviderResponse<T>(params: {
    validator: ProviderPayloadValidator<T>;
    contentTypeHeader: string | undefined;
    rawBody: string;
    limits?: HardenedParserLimits;
  }): ProviderPayloadParseResult<T> {
    const { validator } = params;
    const maxBytes = params.limits?.maxPayloadBytes ?? 65_536;
    const maxDepth = params.limits?.maxNestingDepth ?? 12;
    const maxArrayLen = params.limits?.maxArrayLength ?? 500;

    const fail = (
      code: PayloadValidationErrorCode,
      failedPath: string,
      message: string
    ): ProviderPayloadParseResult<T> => ({
      ok: false,
      error: {
        providerId: validator.providerId,
        schemaVersion: validator.schemaVersion,
        code,
        failedPath,
        message,
      },
    });

    const ct = (params.contentTypeHeader ?? "").toLowerCase();
    if (!ct.includes("application/json")) {
      return fail(
        "INVALID_CONTENT_TYPE",
        "$headers.content-type",
        `Expected application/json content-type, received "${params.contentTypeHeader ?? ""}"`
      );
    }

    const byteLen = Buffer.byteLength(params.rawBody, "utf8");
    if (byteLen > maxBytes) {
      return fail(
        "PAYLOAD_TOO_LARGE",
        "$body",
        `Payload size ${byteLen} bytes exceeds limit ${maxBytes} bytes`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(params.rawBody);
    } catch {
      return fail(
        "MALFORMED_JSON",
        "$body",
        "Failed to parse JSON response body"
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(
        "SCHEMA_FIELD_VALIDATION_FAILED",
        "$",
        "Root JSON value must be a non-null object"
      );
    }

    const structureErr = this.inspectDepthAndArrays(
      parsed,
      "$",
      0,
      maxDepth,
      maxArrayLen
    );
    if (structureErr) {
      return fail(structureErr.code, structureErr.path, structureErr.message);
    }

    const rootObj = parsed as Record<string, unknown>;
    // Detect HTTP 200 error envelopes returned by upstream APIs
    if (
      typeof rootObj.error === "string" ||
      (rootObj.error && typeof rootObj.error === "object") ||
      (rootObj.status &&
        typeof rootObj.status === "object" &&
        typeof (rootObj.status as Record<string, unknown>).error_code ===
          "number" &&
        ((rootObj.status as Record<string, unknown>).error_code as number) !==
          0)
    ) {
      return fail(
        "UPSTREAM_ERROR_ENVELOPE",
        "$.error",
        "Upstream returned HTTP 200 with an embedded error envelope"
      );
    }

    const res = validator.validateParsedObject(rootObj);
    if (!res.ok) {
      return fail(
        "SCHEMA_FIELD_VALIDATION_FAILED",
        res.failedPath,
        res.message
      );
    }

    return {
      ok: true,
      providerId: validator.providerId,
      schemaVersion: validator.schemaVersion,
      data: res.data,
    };
  }

  private static inspectDepthAndArrays(
    node: unknown,
    path: string,
    currentDepth: number,
    maxDepth: number,
    maxArrayLen: number
  ): {
    code: "MAX_NESTING_DEPTH_EXCEEDED" | "MAX_ARRAY_LENGTH_EXCEEDED";
    path: string;
    message: string;
  } | null {
    if (currentDepth > maxDepth) {
      return {
        code: "MAX_NESTING_DEPTH_EXCEEDED",
        path,
        message: `Object nesting depth exceeds maximum (${maxDepth})`,
      };
    }

    if (Array.isArray(node)) {
      if (node.length > maxArrayLen) {
        return {
          code: "MAX_ARRAY_LENGTH_EXCEEDED",
          path,
          message: `Array length ${node.length} exceeds maximum (${maxArrayLen})`,
        };
      }
      for (let i = 0; i < node.length; i++) {
        const sub = this.inspectDepthAndArrays(
          node[i],
          `${path}[${i}]`,
          currentDepth + 1,
          maxDepth,
          maxArrayLen
        );
        if (sub) return sub;
      }
      return null;
    }

    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const sub = this.inspectDepthAndArrays(
          v,
          `${path}.${k}`,
          currentDepth + 1,
          maxDepth,
          maxArrayLen
        );
        if (sub) return sub;
      }
    }

    return null;
  }
}

export interface ValidatedCoinGeckoSpotReading {
  coinId: string;
  usdPrice: number;
  lastUpdatedAtSec: number;
}

export class CoinGeckoSpotPayloadValidator
  implements ProviderPayloadValidator<ValidatedCoinGeckoSpotReading>
{
  public readonly providerId = "coingecko-spot";
  public readonly schemaVersion = "coingecko-simple-price-v1";
  private readonly expectedCoinId: string;

  constructor(expectedCoinId: string) {
    this.expectedCoinId = expectedCoinId;
  }

  public validateParsedObject(
    root: Record<string, unknown>
  ):
    | { ok: true; data: ValidatedCoinGeckoSpotReading }
    | { ok: false; failedPath: string; message: string } {
    const coinObj = root[this.expectedCoinId];
    if (!coinObj || typeof coinObj !== "object" || Array.isArray(coinObj)) {
      return {
        ok: false,
        failedPath: `$.${this.expectedCoinId}`,
        message: `Missing object for coinId "${this.expectedCoinId}"`,
      };
    }

    const entry = coinObj as Record<string, unknown>;
    const usd = entry.usd;
    // Never coerce string numbers or allow non-finite / non-positive prices
    if (
      typeof usd !== "number" ||
      !Number.isFinite(usd) ||
      usd <= 0 ||
      usd > 10_000_000
    ) {
      return {
        ok: false,
        failedPath: `$.${this.expectedCoinId}.usd`,
        message:
          "Field usd must be a finite positive number within (0, 10000000]",
      };
    }

    const updated = entry.last_updated_at;
    if (
      typeof updated !== "number" ||
      !Number.isInteger(updated) ||
      updated <= 1_500_000_000
    ) {
      return {
        ok: false,
        failedPath: `$.${this.expectedCoinId}.last_updated_at`,
        message: "Field last_updated_at must be a valid unix timestamp integer",
      };
    }

    return {
      ok: true,
      data: {
        coinId: this.expectedCoinId,
        usdPrice: usd,
        lastUpdatedAtSec: updated,
      },
    };
  }
}
