import { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import configuration from "../config/configuration";
import { PolicyModule } from "../policy/policy.module";
import { PoolModule } from "../pool/pool.module";
import { QuoteModule } from "../quote/quote.module";
import { STATIC_RESOURCE_CACHE_CONTROL } from "./http-cache";

const CACHED_ROUTES = ["/api/v1/quotes/coverage-types", "/api/v1/policies/types", "/api/v1/pool/stats"];

describe("HTTP caching on read-heavy endpoints", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        QuoteModule,
        PolicyModule,
        PoolModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe.each(CACHED_ROUTES)("GET %s", (route) => {
    it("returns 200 with an ETag and Cache-Control on a cold request", async () => {
      const res = await request(app.getHttpServer()).get(route);

      expect(res.status).toBe(200);
      expect(res.headers.etag).toEqual(expect.any(String));
      expect(res.headers["cache-control"]).toBe(STATIC_RESOURCE_CACHE_CONTROL);
    });

    it("returns 304 with no body when If-None-Match matches", async () => {
      const first = await request(app.getHttpServer()).get(route);
      const second = await request(app.getHttpServer()).get(route).set("If-None-Match", first.headers.etag);

      expect(second.status).toBe(304);
      expect(second.text).toBe("");
      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it("returns 200 with the current ETag when If-None-Match is stale", async () => {
      const first = await request(app.getHttpServer()).get(route);
      const res = await request(app.getHttpServer()).get(route).set("If-None-Match", 'W/"stale"');

      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe(first.headers.etag);
    });
  });

  it("does not mark caller-specific responses as publicly cacheable", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/pool/user/GABC");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});
