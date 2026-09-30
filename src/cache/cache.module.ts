import { Global, Module } from "@nestjs/common";
import { CacheService } from "./cache.service";

/**
 * CacheModule is marked @Global so any feature module that imports
 * AppModule (which imports CacheModule) can inject CacheService without
 * explicitly importing CacheModule itself.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
