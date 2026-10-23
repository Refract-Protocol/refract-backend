import { Injectable, Logger } from "@nestjs/common";
import { loadEndpointDeclarations, loadEndpointOptions, PROVIDER_ADAPTERS, ProviderAdapter } from "./provider-endpoints.config";
import { ProviderEndpointSet } from "./provider-endpoints";

/**
 * One ProviderEndpointSet per oracle data-source adapter. Adapters call
 * `registry.get("coingecko").execute((baseUrl, signal) => ...)` instead of
 * using a fixed base URL, so one unreachable host no longer stalls the feed.
 */
@Injectable()
export class ProviderEndpointRegistry {
  private readonly logger = new Logger(ProviderEndpointRegistry.name);
  private readonly sets = new Map<ProviderAdapter, ProviderEndpointSet>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const declarations = loadEndpointDeclarations(env);
    const options = loadEndpointOptions(env);
    for (const adapter of PROVIDER_ADAPTERS) {
      const set = new ProviderEndpointSet(adapter, declarations[adapter], options, Date.now, (t) => {
        const msg = `${t.adapter}/${t.label}: ${t.from} → ${t.to}${t.error ? ` (${t.error})` : ""}`;
        if (t.to === "down") this.logger.warn(`Endpoint demoted, ${msg}`);
        else if (t.to === "healthy") this.logger.log(`Endpoint restored, ${msg}`);
        else this.logger.log(`Endpoint ${msg}`);
      });
      this.sets.set(adapter, set);
      this.logger.log(`${adapter}: ${set.endpoints.map((e) => e.label).join(" → ")}`);
    }
  }

  get(adapter: ProviderAdapter): ProviderEndpointSet {
    return this.sets.get(adapter)!;
  }

  snapshot() {
    return [...this.sets.values()].map((s) => s.snapshot());
  }
}
