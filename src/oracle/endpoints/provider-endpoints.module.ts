import { Controller, Get, Global, Module } from "@nestjs/common";
import { ProviderEndpointRegistry } from "./provider-endpoint.registry";
import { assertKnownProviderIds, loadEndpointDeclarations } from "./provider-endpoints.config";

@Controller("api/v1/oracle/endpoints")
export class ProviderEndpointsController {
  constructor(private readonly registry: ProviderEndpointRegistry) {}

  /** Live health and current active endpoint per adapter (URLs redacted). */
  @Get("health")
  health() {
    return this.registry.snapshot();
  }
}

@Global()
@Module({
  controllers: [ProviderEndpointsController],
  providers: [
    {
      provide: ProviderEndpointRegistry,
      useFactory: () => {
        assertKnownProviderIds(loadEndpointDeclarations());
        return new ProviderEndpointRegistry();
      },
    },
  ],
  exports: [ProviderEndpointRegistry],
})
export class ProviderEndpointsModule {}
