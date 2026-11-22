import { Module } from "@nestjs/common";
import { CacheModule } from "../cache/cache.module";
import { DbModule } from "../db/db.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { OracleAdminModule } from "../oracle/admin/oracle-admin.module";
import { OracleTrustModule } from "../oracle/oracle-trust.module";

@Module({
  imports: [CacheModule, DbModule, OracleTrustModule, OracleAdminModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
