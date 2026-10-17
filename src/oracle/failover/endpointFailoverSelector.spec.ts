import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderEndpointFailoverClient } from "./endpointFailoverSelector.ts";

describe("Per-Adapter Endpoint Failover and Regional Health Selection (#254)", () => {
  it("fails over to regional mirror when primary fails, demotes unhealthy primary with backoff, and preserves single logical source identity", async () => {
    let primaryHealthy = false;
    const calledEndpoints: string[] = [];

    const client = new ProviderEndpointFailoverClient({
      logicalProviderId: "stellar-horizon-dex",
      upstreamOrigin: "stellar_public_horizon_network",
      maxConsecutiveFailures: 2,
      baseCooldownMs: 30_000,
      endpoints: [
        {
          endpointId: "horizon-us-east",
          baseUrl: "https://horizon.stellar.org",
          region: "us-east-1",
          priority: 1,
        },
        {
          endpointId: "horizon-eu-central",
          baseUrl: "https://horizon-eu.stellar.org",
          region: "eu-central-1",
          priority: 2,
        },
      ],
    });

    const requestStub = async (ep: { endpointId: string }) => {
      calledEndpoints.push(ep.endpointId);
      if (ep.endpointId === "horizon-us-east" && !primaryHealthy) {
        throw new Error("503 Service Unavailable");
      }
      return { data: { price: 0.9999 }, latencyMs: 120 };
    };

    const nowMs = 1_700_000_000_000;

    // Call 1 & Call 2: primary fails twice -> reaches maxConsecutiveFailures (2) and gets demoted
    const res1 = await client.executeWithFailover(requestStub, nowMs);
    assert.equal(res1.servedByEndpointId, "horizon-eu-central");
    assert.equal(res1.failoverUsed, true);
    assert.equal(res1.logicalProviderId, "stellar-horizon-dex");
    assert.equal(res1.upstreamOrigin, "stellar_public_horizon_network");

    const res2 = await client.executeWithFailover(requestStub, nowMs + 1_000);
    assert.equal(res2.servedByEndpointId, "horizon-eu-central");
    assert.equal(client.getMetrics().demotionsTotal, 1);

    // Call 3 (within 30s cooldown at nowMs + 5_000): skips demoted primary directly without hot-looping
    calledEndpoints.length = 0;
    const res3 = await client.executeWithFailover(requestStub, nowMs + 5_000);
    assert.equal(res3.servedByEndpointId, "horizon-eu-central");
    assert.deepEqual(calledEndpoints, ["horizon-eu-central"]);

    // Call 4 (after cooldown expires at nowMs + 35_000 with primary recovered): probes and restores primary
    primaryHealthy = true;
    calledEndpoints.length = 0;
    const res4 = await client.executeWithFailover(requestStub, nowMs + 35_000);
    assert.equal(res4.servedByEndpointId, "horizon-us-east");
    assert.equal(res4.failoverUsed, false);
    assert.equal(client.getMetrics().restorationsTotal, 1);
  });
});
