import { Module } from '@nestjs/common';
import { OracleService } from './oracle.service';
import { OracleController } from './oracle.controller';
import { ReferenceDataModule } from './reference-data/reference-data.module';

@Module({
  imports: [ReferenceDataModule],
  controllers: [OracleController],
  providers: [OracleService],
  exports: [OracleService, ReferenceDataModule],
})
export class OracleModule {}