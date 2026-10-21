import { Module, Global } from "@nestjs/common";
import { DatabaseService } from "./database.service";

/**
 * Global module — import once in AppModule, DatabaseService is then
 * injectable everywhere without re-importing DatabaseModule.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
