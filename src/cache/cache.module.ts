import { Global, Module } from "@nestjs/common";
import { CacheService } from "./cache.service";

/**
 * CacheModule is marked @Global so any feature module that imports
 * AppModule (which imports CacheModule) can inject CacheService without
 * explicitly importing CacheModule itself.
 *
 * When SANDBOX_MODE is enabled, CacheService is registered with an
 * in-memory backing store so no real Redis instance is required. The
 * sandbox flag is read here (at module registration time) rather than
 * branching inside business logic, keeping the swap point in one place.
 */
const SANDBOX_MODE = process.env.SANDBOX_MODE === "true";

@Global()
@Module({
  providers: [
    {
      provide: CacheService,
      useFactory: () => new CacheService({ sandbox: SANDBOX_MODE }),
    },
  ],
  exports: [CacheService],
})
export class CacheModule {}
