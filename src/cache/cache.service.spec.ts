import { ConfigService } from "@nestjs/config";
import { CacheService, ORACLE_TTL } from "./cache.service";
import { AppConfig } from "../config/configuration";

/**
 * Unit tests for CacheService.
 *
 * ioredis is mocked entirely — these tests validate the get/set/wrap
 * logic and fail-open behaviour without a live Redis instance.
 */

// ── Mock ioredis ────────────────────────────────────────────────────────────
const mockRedisInstance = {
  on: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  quit: jest.fn().mockResolvedValue("OK"),
};

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => mockRedisInstance);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildService(): CacheService {
  const configService = {
    get: jest.fn().mockReturnValue({ url: "redis://localhost:6379" }),
  } as unknown as ConfigService<AppConfig, true>;
  const svc = new CacheService(configService);
  svc.onModuleInit();
  return svc;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CacheService", () => {
  let service: CacheService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe("get()", () => {
    it("returns parsed JSON on a cache hit", async () => {
      mockRedisInstance.get.mockResolvedValueOnce(JSON.stringify({ value: 42 }));
      const result = await service.get<{ value: number }>("key");
      expect(result).toEqual({ value: 42 });
    });

    it("returns null on a cache miss", async () => {
      mockRedisInstance.get.mockResolvedValueOnce(null);
      expect(await service.get("key")).toBeNull();
    });

    it("returns null and does not throw when Redis errors (fail-open)", async () => {
      mockRedisInstance.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(service.get("key")).resolves.toBeNull();
    });
  });

  describe("set()", () => {
    it("stores JSON-serialised value with EX ttl", async () => {
      mockRedisInstance.set.mockResolvedValueOnce("OK");
      await service.set("k", { x: 1 }, 60);
      expect(mockRedisInstance.set).toHaveBeenCalledWith("k", JSON.stringify({ x: 1 }), "EX", 60);
    });

    it("does not throw when Redis errors (fail-open)", async () => {
      mockRedisInstance.set.mockRejectedValueOnce(new Error("write error"));
      await expect(service.set("k", {}, 60)).resolves.toBeUndefined();
    });
  });

  describe("del()", () => {
    it("calls redis.del with provided keys", async () => {
      mockRedisInstance.del.mockResolvedValueOnce(1);
      await service.del("a", "b");
      expect(mockRedisInstance.del).toHaveBeenCalledWith("a", "b");
    });

    it("does not call redis.del when no keys provided", async () => {
      await service.del();
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });
  });

  describe("wrap()", () => {
    it("returns cached value without calling loader on a hit", async () => {
      const cached = [{ coverageType: "StablecoinDepeg", severity: "low" }];
      mockRedisInstance.get.mockResolvedValueOnce(JSON.stringify(cached));

      const loader = jest.fn();
      const result = await service.wrap("oracle:checkAll", ORACLE_TTL, loader);

      expect(result).toEqual(cached);
      expect(loader).not.toHaveBeenCalled();
    });

    it("calls loader, caches the result, and returns it on a miss", async () => {
      mockRedisInstance.get.mockResolvedValueOnce(null);
      mockRedisInstance.set.mockResolvedValueOnce("OK");

      const fresh = [{ coverageType: "MarketCrash", severity: "high" }];
      const loader = jest.fn().mockResolvedValueOnce(fresh);

      const result = await service.wrap("oracle:checkAll", ORACLE_TTL, loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toEqual(fresh);
      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        "oracle:checkAll",
        JSON.stringify(fresh),
        "EX",
        ORACLE_TTL
      );
    });

    it("returns loader result without caching when Redis is unavailable (fail-open)", async () => {
      mockRedisInstance.get.mockRejectedValueOnce(new Error("down"));
      mockRedisInstance.set.mockRejectedValueOnce(new Error("down"));

      const fresh = { ok: true };
      const loader = jest.fn().mockResolvedValueOnce(fresh);

      await expect(service.wrap("key", 30, loader)).resolves.toEqual(fresh);
    });
  });

  describe("ORACLE_TTL constant", () => {
    it("is 55 seconds — just under the 60s scheduler interval", () => {
      expect(ORACLE_TTL).toBe(55);
    });
  });
});
