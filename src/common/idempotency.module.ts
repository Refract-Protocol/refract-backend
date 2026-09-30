import { Module, Global } from "@nestjs/common";
import { IdempotencyService } from "./idempotency.service";

/**
 * Global so PolicyModule, PoolModule, and TxModule can inject
 * IdempotencyService without each importing this module explicitly.
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
