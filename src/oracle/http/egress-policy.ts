/**
 * Egress policy types and the IP deny-list.
 *
 * Defines what a provider adapter is allowed to contact, and blocks
 * non-routable, loopback, link-local, and cloud-metadata address ranges
 * in all encoding forms (decimal, hex, octal, IPv4-in-IPv6, zone-ID).
 */

import { DomainError } from "../../common/errors";

// ── Typed error ────────────────────────────────────────────────────────────

export class EgressDeniedError extends DomainError {
  readonly code = "EGRESS_DENIED";
  readonly status = 403;

  constructor(
    message: string,
    public readonly reason:
      | "disallowed_host"
      | "disallowed_scheme"
      | "private_ip"
      | "metadata_ip"
      | "redirect_limit"
      | "redirect_host"
      | "body_too_large"
      | "content_type_rejected",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

// ── Per-adapter policy ─────────────────────────────────────────────────────

export interface AdapterEgressPolicy {
  /** Allowlisted hostnames (exact match, no wildcards). */
  allowedHosts: string[];
  /**
   * Optional path prefixes per host.
   * If absent, all paths on an allowed host are permitted.
   */
  allowedPathPrefixes?: Record<string, string[]>;
  /** Schemes permitted (default: https only in production). */
  allowedSchemes?: string[];
  /** Maximum redirect hops (default: 3). */
  maxRedirects?: number;
  /** Maximum response body size in bytes (default: 1 MiB). */
  maxBodyBytes?: number;
  /** Accepted Content-Type prefixes (default: ["application/json"]). */
  acceptedContentTypes?: string[];
}

export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB
export const DEFAULT_ALLOWED_SCHEMES = ["https"];
export const DEFAULT_ACCEPTED_CONTENT_TYPES = ["application/json"];

// ── Blocked CIDR ranges ────────────────────────────────────────────────────

/**
 * Returns true when a resolved IPv4 address (dotted-decimal, already
 * normalised) falls inside a non-routable or sensitive range.
 *
 * Blocked ranges:
 *   0.0.0.0/8        — "this" network
 *   10.0.0.0/8       — private
 *   100.64.0.0/10    — shared address space (RFC 6598)
 *   127.0.0.0/8      — loopback
 *   169.254.0.0/16   — link-local / AWS metadata (169.254.169.254)
 *   172.16.0.0/12    — private
 *   192.0.0.0/24     — IANA special
 *   192.168.0.0/16   — private
 *   198.18.0.0/15    — benchmarking
 *   198.51.100.0/24  — documentation
 *   203.0.113.0/24   — documentation
 *   224.0.0.0/4      — multicast
 *   240.0.0.0/4      — reserved
 *   255.255.255.255  — broadcast
 */
export function isBlockedIPv4(addr: string): boolean {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // unparseable → deny
  }
  const [a, b, c] = parts;

  return (
    a === 0 ||                                       // 0.0.0.0/8
    a === 10 ||                                      // 10.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) ||            // 100.64.0.0/10
    a === 127 ||                                     // 127.0.0.0/8
    (a === 169 && b === 254) ||                      // 169.254.0.0/16 (metadata)
    (a === 172 && b >= 16 && b <= 31) ||             // 172.16.0.0/12
    (a === 192 && b === 0 && c === 0) ||             // 192.0.0.0/24
    (a === 192 && b === 168) ||                      // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) ||         // 198.18.0.0/15
    (a === 198 && b === 51 && c === 100) ||          // 198.51.100.0/24
    (a === 203 && b === 0 && c === 113) ||           // 203.0.113.0/24
    a >= 224                                         // multicast + reserved
  );
}

/**
 * Returns true when an IPv6 address (unexpanded, as returned by dns.resolve6)
 * is non-routable or maps to a blocked IPv4 range.
 *
 * Blocked:
 *   ::1              — loopback
 *   fc00::/7         — unique local (fd00::/8 included)
 *   fe80::/10        — link-local
 *   ::ffff:0:0/96    — IPv4-mapped IPv6 (check underlying IPv4)
 *   64:ff9b::/96     — IPv4-IPv6 translation
 *   100::/64         — discard prefix
 *   2001:db8::/32    — documentation
 */
export function isBlockedIPv6(addr: string): boolean {
  // Strip zone identifier (e.g. fe80::1%eth0)
  const clean = addr.split("%")[0].toLowerCase();

  if (clean === "::1") return true;

  // IPv4-mapped: ::ffff:a.b.c.d or ::ffff:0a0b:0c0d
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
  if (v4mapped) return isBlockedIPv4(v4mapped[1]);

  // IPv4-mapped hex form: ::ffff:c0a8:0001 → 192.168.0.1
  const v4mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(clean);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIPv4(ipv4);
  }

  // fc00::/7 — unique local (fc00:: to fdff::)
  if (/^f[cd]/.test(clean)) return true;

  // fe80::/10 — link-local
  if (/^fe[89ab]/.test(clean)) return true;

  // 64:ff9b::/96 — NAT64
  if (clean.startsWith("64:ff9b:")) return true;

  // 100::/64 — discard
  if (clean.startsWith("100::")) return true;

  // 2001:db8::/32 — documentation
  if (clean.startsWith("2001:db8:")) return true;

  return false;
}

/**
 * Validates a hostname string from config (no scheme, no path).
 * Returns the normalised lowercase hostname or throws.
 */
export function normaliseHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("@")) {
    throw new Error(`Invalid hostname in allowlist: "${raw}"`);
  }
  return trimmed;
}

/**
 * Validates all hosts in an AdapterEgressPolicy are syntactically valid
 * and returns the normalised policy. Throws on the first bad hostname.
 */
export function validateEgressPolicy(policy: AdapterEgressPolicy): AdapterEgressPolicy {
  return {
    ...policy,
    allowedHosts: policy.allowedHosts.map(normaliseHostname),
    allowedSchemes: policy.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES,
    maxRedirects: policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    maxBodyBytes: policy.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    acceptedContentTypes: policy.acceptedContentTypes ?? DEFAULT_ACCEPTED_CONTENT_TYPES,
  };
}
