import { RpcEndpointPool, RpcEndpointPoolOptions, isTransientRpcError } from "./rpc-endpoint-pool";
import { resolveRpcPoolConfig } from "./rpc-pool.config";
import { envSchema } from "../config/env.schema";

interface FakeServer {
  url: string;
  getHealth: jest.Mock<Promise<{ status: string; latestLedger?: number }>, []>;
  read: jest.Mock<Promise<string>, []>;
}

function makePool(urls: string[], options: RpcEndpointPoolOptions<FakeServer> = {}) {
  const servers = new Map<string, FakeServer>();
  let clock = 1_000_000;
  const pool = new RpcEndpointPool<FakeServer>(urls, {
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    healthCheckIntervalMs: 0,
    now: () => clock,
    serverFactory: (url) => {
      const server: FakeServer = {
        url,
        getHealth: jest.fn().mockResolvedValue({ status: "healthy", latestLedger: 1000 }),
        read: jest.fn().mockResolvedValue(url),
      };
      servers.set(url, server);
      return server;
    },
    ...options,
  });
  return {
    pool,
    server: (url: string) => servers.get(url)!,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const transient = () => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

describe("RpcEndpointPool", () => {
  it("rejects an empty endpoint list", () => {
    expect(() => new RpcEndpointPool([" ", ""])).toThrow(/At least one Soroban RPC URL/);
  });

  it("deduplicates endpoints and prefers configured order when health is equal", () => {
    const { pool } = makePool([A, B, A, C]);
    expect(pool.size).toBe(3);
    expect(pool.rankedUrls()).toEqual([A, B, C]);
  });

  it("rotates away from an endpoint whose health probe fails", async () => {
    const { pool, server } = makePool([A, B]);
    server(A).getHealth.mockRejectedValue(new Error("fetch failed"));

    await pool.checkHealth();

    expect(pool.rankedUrls()).toEqual([B, A]);
    await expect(pool.call((s) => s.read())).resolves.toBe(B);
    expect(server(A).read).not.toHaveBeenCalled();
    expect(pool.snapshot().find((e) => e.url === A)?.state).toBe("unhealthy");
  });

  it("treats a non-healthy status report as unhealthy", async () => {
    const { pool, server } = makePool([A, B]);
    server(A).getHealth.mockResolvedValue({ status: "unhealthy", latestLedger: 1000 });

    await pool.checkHealth();

    expect(pool.rankedUrls()[0]).toBe(B);
  });

  it("demotes an endpoint that trails the head ledger by more than maxLedgerLag", async () => {
    const { pool, server } = makePool([A, B, C], { maxLedgerLag: 5 });
    server(A).getHealth.mockResolvedValue({ status: "healthy", latestLedger: 990 });
    server(B).getHealth.mockResolvedValue({ status: "healthy", latestLedger: 1000 });
    server(C).getHealth.mockResolvedValue({ status: "healthy", latestLedger: 997 });

    await pool.checkHealth();

    expect(pool.rankedUrls()).toEqual([B, C, A]);
    const lagging = pool.snapshot().find((e) => e.url === A)!;
    expect(lagging.state).toBe("lagging");
    expect(lagging.ledgerLag).toBe(10);
  });

  it("fails over on transient call errors and marks the endpoint unhealthy at the threshold", async () => {
    const { pool, server } = makePool([A, B], { failureThreshold: 2 });
    server(A).read.mockRejectedValue(transient());

    await expect(pool.call((s) => s.read())).resolves.toBe(B);
    // One failure is below the threshold: A is still healthy-ranked, so a
    // fresh purpose tries it first, fails a second time, and trips the breaker.
    expect(pool.rankedUrls("submit")[0]).toBe(A);
    await expect(pool.call((s) => s.read(), "submit")).resolves.toBe(B);

    expect(server(A).read).toHaveBeenCalledTimes(2);
    expect(pool.snapshot().find((e) => e.url === A)?.state).toBe("unhealthy");
  });

  it("does not retry or rotate on non-transient errors", async () => {
    const { pool, server } = makePool([A, B]);
    const error = new Error("HostError: contract trapped");
    server(A).read.mockRejectedValue(error);

    await expect(pool.call((s) => s.read())).rejects.toBe(error);
    expect(server(B).read).not.toHaveBeenCalled();
  });

  it("still uses unhealthy endpoints as a last resort", async () => {
    const { pool, server } = makePool([A, B], { maxAttempts: 1 });
    server(A).getHealth.mockRejectedValue(new Error("timeout"));
    server(B).getHealth.mockRejectedValue(new Error("timeout"));
    await pool.checkHealth();

    expect(pool.isServiceable()).toBe(false);
    await expect(pool.call((s) => s.read())).resolves.toBe(A);
  });

  it("retries an unhealthy endpoint after its cooldown and restores it on success", async () => {
    const { pool, server, advance } = makePool([A, B], { cooldownMs: 10_000 });
    server(A).getHealth.mockRejectedValueOnce(new Error("timeout"));
    await pool.checkHealth();
    expect(pool.rankedUrls()[0]).toBe(B);

    advance(10_000);
    expect(pool.snapshot().find((e) => e.url === A)?.state).toBe("unknown");

    await pool.checkHealth();
    expect(pool.rankedUrls()).toEqual([A, B]);
  });

  it("keeps event polling sticky to the endpoint that served the last page", async () => {
    const { pool, server } = makePool([A, B]);
    server(A).read.mockRejectedValueOnce(transient());

    await expect(pool.call((s) => s.read(), "events")).resolves.toBe(B);
    // A is healthy again, but events stay on B so paging cursors remain valid.
    await expect(pool.call((s) => s.read(), "events")).resolves.toBe(B);
    // Sticky choice is per purpose.
    expect(pool.rankedUrls("submit")[0]).toBe(A);
  });

  it("gives up after maxAttempts rounds and rethrows the last transient error", async () => {
    const { pool, server } = makePool([A, B], { maxAttempts: 2, failureThreshold: 99 });
    server(A).read.mockRejectedValue(transient());
    server(B).read.mockRejectedValue(transient());

    await expect(pool.call((s) => s.read())).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(server(A).read).toHaveBeenCalledTimes(2);
    expect(server(B).read).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe between concurrent health checks", async () => {
    const { pool, server } = makePool([A]);
    await Promise.all([pool.checkHealth(), pool.checkHealth()]);
    expect(server(A).getHealth).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientRpcError", () => {
  it.each([
    [{ status: 503 }, true],
    [{ statusCode: 429 }, true],
    [{ code: "ETIMEDOUT" }, true],
    [new Error("gateway timeout"), true],
    [new Error("invalid contract arguments"), false],
    [{ status: 400 }, false],
    [null, false],
  ])("%p -> %p", (error, expected) => {
    expect(isTransientRpcError(error)).toBe(expected);
  });
});

describe("resolveRpcPoolConfig", () => {
  it("merges SOROBAN_RPC_URL with SOROBAN_RPC_URLS, primary first, without duplicates", () => {
    const config = resolveRpcPoolConfig({
      SOROBAN_RPC_URL: A,
      SOROBAN_RPC_URLS: `${B}, ${A},${C}`,
      SOROBAN_RPC_MAX_LEDGER_LAG: "4",
    });
    expect(config.urls).toEqual([A, B, C]);
    expect(config.options.maxLedgerLag).toBe(4);
  });

  it("falls back to the network's public endpoint only off mainnet", () => {
    expect(resolveRpcPoolConfig({ STELLAR_NETWORK: "testnet" }).urls).toEqual([
      "https://soroban-testnet.stellar.org",
    ]);
    expect(resolveRpcPoolConfig({ STELLAR_NETWORK: "mainnet" }).urls).toEqual([]);
  });
});

describe("envSchema RPC pool settings", () => {
  it("rejects an invalid URL inside SOROBAN_RPC_URLS", () => {
    const result = envSchema.safeParse({ SOROBAN_RPC_URLS: `${A},not a url` });
    expect(result.success).toBe(false);
  });

  it("accepts SOROBAN_RPC_URLS in place of SOROBAN_RPC_URL when chain config is required", () => {
    const result = envSchema.safeParse({
      REQUIRE_CHAIN_CONFIG: "true",
      SOROBAN_RPC_URLS: `${A},${B}`,
    });
    expect(result.success).toBe(false);
    const keys = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
    expect(keys).not.toContain("SOROBAN_RPC_URL");
  });
});
