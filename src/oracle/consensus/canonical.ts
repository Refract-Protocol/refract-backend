import { createHash } from "crypto";

/**
 * Deterministic JSON serialisation: object keys are sorted, `undefined`
 * fields are dropped, and non-finite numbers are rejected. Two payloads that
 * differ only cosmetically (whitespace, key order) serialise to the same
 * string, which is what lets us content-address raw payloads and guarantee
 * byte-identical reconstruction output.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number ${value}`);
    }
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalise(v);
  }
  return out;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Content address of a raw provider payload. Strings that parse as JSON are
 * canonicalised first so re-serialised copies of the same body share a hash.
 */
export function payloadHash(body: string): string {
  try {
    return sha256Hex(canonicalJson(JSON.parse(body)));
  } catch {
    return sha256Hex(body);
  }
}
