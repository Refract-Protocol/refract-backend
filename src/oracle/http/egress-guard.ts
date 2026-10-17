import { promises as dnsPromises } from "node:dns";
import net from "node:net";

export type EgressDenyReason =
  | "invalid_url"
  | "disallowed_scheme"
  | "credentials_in_url"
  | "host_not_allowlisted"
  | "path_not_allowlisted"
  | "private_or_metadata_ip"
  | "dns_resolution_failed"
  | "redirect_location_missing"
  | "redirect_hop_limit_exceeded"
  | "disallowed_content_type"
  | "response_too_large";

export class EgressDeniedError extends Error {
  readonly reason: EgressDenyReason;
  readonly adapterId: string;
  readonly url: string;
  readonly detail?: string;

  constructor(params: {
    reason: EgressDenyReason;
    adapterId: string;
    url: string;
    message: string;
    detail?: string;
  }) {
    super(params.message);
    this.name = "EgressDeniedError";
    this.reason = params.reason;
    this.adapterId = params.adapterId;
    this.url = params.url;
    this.detail = params.detail;
  }
}

export interface HostAllowlistRule {
  hostname: string;
  allowedPathPrefixes?: readonly string[];
}

export interface AdapterEgressPolicy {
  adapterId: string;
  allowedHosts: readonly HostAllowlistRule[];
  allowHttpInDev?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  allowedContentTypes?: readonly string[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolverFn = (hostname: string) => Promise<ResolvedAddress[]>;

export const DEFAULT_PROVIDER_ALLOWLIST: Readonly<Record<string, AdapterEgressPolicy>> = Object.freeze({
  coingecko: {
    adapterId: "coingecko",
    allowedHosts: [
      {
        hostname: "api.coingecko.com",
        allowedPathPrefixes: ["/api/v3/"],
      },
    ],
  },
  defillama: {
    adapterId: "defillama",
    allowedHosts: [
      {
        hostname: "api.llama.fi",
        allowedPathPrefixes: ["/protocol/", "/tvl/", "/v2/"],
      },
    ],
  },
  horizon: {
    adapterId: "horizon",
    allowedHosts: [
      {
        hostname: "horizon-testnet.stellar.org",
        allowedPathPrefixes: ["/"],
      },
      {
        hostname: "horizon-futurenet.stellar.org",
        allowedPathPrefixes: ["/"],
      },
      {
        hostname: "horizon.stellar.org",
        allowedPathPrefixes: ["/"],
      },
    ],
  },
});

/**
 * Validates an adapter's egress policy configuration when a feed config is
 * loaded or updated. Rejects wildcard hosts, IP literals in allowlists, or
 * non-normalized path prefixes.
 */
export function validateFeedEgressConfig(policy: AdapterEgressPolicy): void {
  if (!policy || typeof policy.adapterId !== "string" || !policy.adapterId.trim()) {
    throw new Error("AdapterEgressPolicy requires a non-empty adapterId");
  }
  if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0) {
    throw new Error(`AdapterEgressPolicy for "${policy.adapterId}" requires at least one allowedHost`);
  }
  for (const rule of policy.allowedHosts) {
    const host = (rule.hostname || "").trim().toLowerCase();
    if (!host || host.includes("*") || host.includes("/") || host.includes(":")) {
      throw new Error(`Invalid allowlist hostname "${rule.hostname}" for adapter "${policy.adapterId}"`);
    }
    if (isNumericOrEncodedIpLiteral(host) || net.isIP(host) !== 0) {
      throw new Error(`Allowlist hostname "${rule.hostname}" must be a DNS name, not an IP literal`);
    }
    if (rule.allowedPathPrefixes) {
      for (const prefix of rule.allowedPathPrefixes) {
        if (!prefix.startsWith("/") || prefix.includes("..")) {
          throw new Error(`Invalid allowedPathPrefix "${prefix}" for hostname "${rule.hostname}"`);
        }
      }
    }
  }
}

/**
 * Detects non-standard IPv4 literal forms (single 32-bit decimal integer,
 * octal dotted-quad like 0177.0.0.1, or hex dotted-quad like 0x7f.0.0.1)
 * and converts them into canonical dotted-quad IPv4 strings if they are
 * numeric IPv4 encodings.
 */
export function normalizeNumericIpv4Literal(host: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return null;

  // Single integer (decimal or hex) e.g. 2852039166 or 0x7f000001
  if (/^(0x[0-9a-f]+|\d+)$/i.test(trimmed)) {
    const n = trimmed.startsWith("0x") ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return "0.0.0.0";
    return [
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ].join(".");
  }

  const parts = trimmed.split(".");
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(p))) {
    const nums: number[] = [];
    for (const part of parts) {
      let val: number;
      if (part.startsWith("0x")) {
        val = Number.parseInt(part.slice(2), 16);
      } else if (part.length > 1 && part.startsWith("0")) {
        val = Number.parseInt(part.slice(1), 8);
      } else {
        val = Number.parseInt(part, 10);
      }
      if (!Number.isFinite(val) || val < 0) return null;
      nums.push(val);
    }

    if (parts.length === 4 && nums.every((v) => v <= 255)) {
      return nums.join(".");
    }
    if (parts.length === 3 && nums[0] <= 255 && nums[1] <= 255 && nums[2] <= 0xffff) {
      return `${nums[0]}.${nums[1]}.${(nums[2] >>> 8) & 0xff}.${nums[2] & 0xff}`;
    }
    if (parts.length === 2 && nums[0] <= 255 && nums[1] <= 0xffffff) {
      return `${nums[0]}.${(nums[1] >>> 16) & 0xff}.${(nums[1] >>> 8) & 0xff}.${nums[1] & 0xff}`;
    }
    return "0.0.0.0";
  }

  return null;
}

export function isNumericOrEncodedIpLiteral(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, "");
  if (unwrapped.includes("%")) return true;
  if (net.isIP(unwrapped) !== 0) return true;
  return normalizeNumericIpv4Literal(unwrapped) !== null;
}

function ipv4ToUint32(ipv4: string): number | null {
  const parts = ipv4.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) return null;
    acc = ((acc << 8) | octet) >>> 0;
  }
  return acc >>> 0;
}

function inCidr4(ipUint: number, baseIp: string, prefixLen: number): boolean {
  const base = ipv4ToUint32(baseIp);
  if (base === null) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipUint & mask) >>> 0 === (base & mask) >>> 0;
}

const FORBIDDEN_IPV4_CIDRS: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "unspecified_this_network"],
  ["10.0.0.0", 8, "rfc1918_private"],
  ["100.64.0.0", 10, "cgnat_shared_space"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link_local_or_cloud_metadata"],
  ["172.16.0.0", 12, "rfc1918_private"],
  ["192.0.0.0", 24, "ietf_protocol_assignments"],
  ["192.0.2.0", 24, "test_net_1"],
  ["192.168.0.0", 16, "rfc1918_private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "test_net_2"],
  ["203.0.113.0", 24, "test_net_3"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved_or_broadcast"],
];

function expandIpv6Hextets(rawIpv6: string): number[] | null {
  let addr = rawIpv6.trim().toLowerCase();
  if (addr.startsWith("[") && addr.endsWith("]")) {
    addr = addr.slice(1, -1);
  }
  // Reject IPv6 zone identifiers (RFC 4007 %eth0)
  if (addr.includes("%")) return null;

  // Handle embedded dotted-quad IPv4 at the end of IPv6 (e.g. ::ffff:169.254.169.254)
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const ipv4Tail = normalizeNumericIpv4Literal(addr.slice(lastColon + 1)) ?? addr.slice(lastColon + 1);
    const ipUint = ipv4ToUint32(ipv4Tail);
    if (ipUint === null) return null;
    const hi = ((ipUint >>> 16) & 0xffff).toString(16);
    const lo = (ipUint & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(":");
    const out: number[] = [];
    for (const t of tokens) {
      if (!/^[0-9a-f]{1,4}$/i.test(t)) return null;
      out.push(Number.parseInt(t, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSegmentList(doubleColonParts[0]);
    const right = parseSegmentList(doubleColonParts[1]);
    if (!left || !right || left.length + right.length >= 8) return null;
    const zeros = new Array<number>(8 - left.length - right.length).fill(0);
    return [...left, ...zeros, ...right];
  }

  const full = parseSegmentList(addr);
  if (!full || full.length !== 8) return null;
  return full;
}

/**
 * Returns a human-readable deny reason if the supplied IP address (IPv4, IPv6,
 * IPv4-mapped IPv6, or non-standard octal/hex/decimal encoding) falls within
 * any non-routable, private, loopback, or cloud metadata range. Returns null
 * when the IP is a globally routable public unicast address.
 */
export function classifyForbiddenIp(rawAddress: string): string | null {
  const trimmed = (rawAddress || "").trim().replace(/^\[|\]$/g, "");
  if (!trimmed) return "empty_ip";
  if (trimmed.includes("%")) return "ipv6_zone_id_forbidden";

  const normalizedV4 = normalizeNumericIpv4Literal(trimmed);
  if (normalizedV4 !== null) {
    const ipUint = ipv4ToUint32(normalizedV4);
    if (ipUint === null) return "malformed_ipv4";
    for (const [base, prefix, label] of FORBIDDEN_IPV4_CIDRS) {
      if (inCidr4(ipUint, base, prefix)) {
        return `ipv4_${label}`;
      }
    }
    return null;
  }

  if (net.isIP(trimmed) === 6 || trimmed.includes(":")) {
    const hextets = expandIpv6Hextets(trimmed);
    if (!hextets) return "malformed_ipv6";

    const allZeroTop80 = hextets.slice(0, 5).every((h) => h === 0);
    // Unspecified ::/128
    if (allZeroTop80 && hextets[5] === 0 && hextets[6] === 0 && hextets[7] === 0) {
      return "ipv6_unspecified";
    }
    // Loopback ::1/128
    if (allZeroTop80 && hextets[5] === 0 && hextets[6] === 0 && hextets[7] === 1) {
      return "ipv6_loopback";
    }
    // IPv4-mapped (::ffff:w.x.y.z) or IPv4-compatible (::w.x.y.z)
    if (allZeroTop80 && (hextets[5] === 0xffff || hextets[5] === 0)) {
      const embeddedUint = (((hextets[6] & 0xffff) << 16) | (hextets[7] & 0xffff)) >>> 0;
      for (const [base, prefix, label] of FORBIDDEN_IPV4_CIDRS) {
        if (inCidr4(embeddedUint, base, prefix)) {
          return `ipv6_mapped_${label}`;
        }
      }
      return null;
    }
    // NAT64 well-known prefix 64:ff9b::/96
    if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)) {
      const embeddedUint = (((hextets[6] & 0xffff) << 16) | (hextets[7] & 0xffff)) >>> 0;
      for (const [base, prefix, label] of FORBIDDEN_IPV4_CIDRS) {
        if (inCidr4(embeddedUint, base, prefix)) {
          return `ipv6_nat64_${label}`;
        }
      }
    }
    // 6to4 2002::/16 embeds IPv4 in hextets[1..2]
    if (hextets[0] === 0x2002) {
      const embeddedUint = (((hextets[1] & 0xffff) << 16) | (hextets[2] & 0xffff)) >>> 0;
      for (const [base, prefix, label] of FORBIDDEN_IPV4_CIDRS) {
        if (inCidr4(embeddedUint, base, prefix)) {
          return `ipv6_6to4_${label}`;
        }
      }
    }
    // Unique local fc00::/7 (fc00..fdff)
    if ((hextets[0] & 0xfe00) === 0xfc00) return "ipv6_unique_local";
    // Link-local fe80::/10 (fe80..febf)
    if ((hextets[0] & 0xffc0) === 0xfe80) return "ipv6_link_local";
    // Multicast ff00::/8
    if ((hextets[0] & 0xff00) === 0xff00) return "ipv6_multicast";
    // Documentation 2001:db8::/32
    if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return "ipv6_documentation";

    return null;
  }

  return "unrecognized_ip_format";
}

export function isForbiddenIpAddress(rawAddress: string): boolean {
  return classifyForbiddenIp(rawAddress) !== null;
}

export const defaultDnsResolver: DnsResolverFn = async (hostname: string): Promise<ResolvedAddress[]> => {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));
};

function normalizePathForAllowlist(pathname: string): string {
  // Decode percent-encoded traversal sequences before checking prefix
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return "";
  }
  const segments = decoded.split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return "";
    stack.push(seg);
  }
  const leading = "/" + stack.join("/");
  return decoded.endsWith("/") && leading !== "/" ? `${leading}/` : leading;
}

/**
 * Validates a target URL against the adapter's egress policy, resolves DNS,
 * verifies every resolved IP is globally routable, and returns the pinned IP
 * address to use for the underlying socket connection.
 */
export async function validateAndResolveEgressTarget(
  rawUrl: string,
  policy: AdapterEgressPolicy,
  resolver: DnsResolverFn = defaultDnsResolver
): Promise<{
  parsedUrl: URL;
  pinnedAddress: ResolvedAddress;
  allAddresses: ResolvedAddress[];
}> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new EgressDeniedError({
      reason: "invalid_url",
      adapterId: policy.adapterId,
      url: rawUrl,
      message: `Invalid provider URL "${rawUrl}"`,
    });
  }

  const scheme = parsedUrl.protocol.toLowerCase();
  if (scheme !== "https:" && !(scheme === "http:" && policy.allowHttpInDev === true)) {
    throw new EgressDeniedError({
      reason: "disallowed_scheme",
      adapterId: policy.adapterId,
      url: rawUrl,
      detail: scheme,
      message: `Disallowed URL scheme "${scheme}" for adapter "${policy.adapterId}" (https required)`,
    });
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new EgressDeniedError({
      reason: "credentials_in_url",
      adapterId: policy.adapterId,
      url: rawUrl,
      message: `Credentials in URL are forbidden for adapter "${policy.adapterId}"`,
    });
  }

  const rawHost = parsedUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (isNumericOrEncodedIpLiteral(rawHost)) {
    const ipReason = classifyForbiddenIp(rawHost) ?? "ip_literal_not_allowlisted";
    throw new EgressDeniedError({
      reason: "private_or_metadata_ip",
      adapterId: policy.adapterId,
      url: rawUrl,
      detail: ipReason,
      message: `Direct IP literal "${rawHost}" is forbidden (${ipReason})`,
    });
  }

  const matchingHostRule = policy.allowedHosts.find(
    (rule) => rule.hostname.toLowerCase().replace(/\.$/, "") === rawHost
  );
  if (!matchingHostRule) {
    throw new EgressDeniedError({
      reason: "host_not_allowlisted",
      adapterId: policy.adapterId,
      url: rawUrl,
      detail: rawHost,
      message: `Hostname "${rawHost}" is not allowlisted for adapter "${policy.adapterId}"`,
    });
  }

  const normalizedPath = normalizePathForAllowlist(parsedUrl.pathname || "/");
  if (!normalizedPath) {
    throw new EgressDeniedError({
      reason: "path_not_allowlisted",
      adapterId: policy.adapterId,
      url: rawUrl,
      detail: parsedUrl.pathname,
      message: `Path traversal or malformed path "${parsedUrl.pathname}" rejected`,
    });
  }

  if (matchingHostRule.allowedPathPrefixes && matchingHostRule.allowedPathPrefixes.length > 0) {
    const pathAllowed = matchingHostRule.allowedPathPrefixes.some((prefix) =>
      normalizedPath.startsWith(prefix)
    );
    if (!pathAllowed) {
      throw new EgressDeniedError({
        reason: "path_not_allowlisted",
        adapterId: policy.adapterId,
        url: rawUrl,
        detail: normalizedPath,
        message: `Path "${normalizedPath}" is not permitted for host "${rawHost}"`,
      });
    }
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await resolver(rawHost);
  } catch (err) {
    throw new EgressDeniedError({
      reason: "dns_resolution_failed",
      adapterId: policy.adapterId,
      url: rawUrl,
      detail: err instanceof Error ? err.message : String(err),
      message: `DNS resolution failed for "${rawHost}"`,
    });
  }

  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new EgressDeniedError({
      reason: "dns_resolution_failed",
      adapterId: policy.adapterId,
      url: rawUrl,
      message: `DNS resolution returned no records for "${rawHost}"`,
    });
  }

  // Every resolved record must pass the IP deny list (multi-A/AAAA CDN records
  // are allowed as long as all returned IPs are globally routable).
  for (const record of resolved) {
    const denyLabel = classifyForbiddenIp(record.address);
    if (denyLabel !== null) {
      throw new EgressDeniedError({
        reason: "private_or_metadata_ip",
        adapterId: policy.adapterId,
        url: rawUrl,
        detail: `${record.address} (${denyLabel})`,
        message: `Hostname "${rawHost}" resolved to forbidden IP ${record.address} (${denyLabel})`,
      });
    }
  }

  return {
    parsedUrl,
    pinnedAddress: resolved[0],
    allAddresses: resolved,
  };
}

/**
 * Static enforcement helper: scans provider adapter TypeScript source to ensure
 * adapters do not invoke raw `fetch(` or import `axios` directly instead of
 * going through `ProviderHttpClient`.
 */
export function scanAdapterSourceForRawHttp(sourceCode: string, fileName = "adapter.ts"): string[] {
  const stripped = sourceCode
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const violations: string[] = [];

  if (/\bimport\s+[^;]*from\s+["']axios["']/.test(stripped) || /\brequire\(\s*["']axios["']\s*\)/.test(stripped)) {
    violations.push(`${fileName}: direct axios import is forbidden in provider adapters; use ProviderHttpClient`);
  }
  if (/(?:^|[^\w.$])(?:globalThis\.)?fetch\s*\(/.test(stripped)) {
    violations.push(`${fileName}: direct fetch() call is forbidden in provider adapters; use ProviderHttpClient`);
  }
  return violations;
}
