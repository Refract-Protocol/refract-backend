import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../db/database.module';
import { OracleService } from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleMonitorService } from '../services/oracleMonitor';
import { ClaimProcessorService } from '../services/claimProcessor';
import { MethodologyRepository } from './methodology.repository';
import { MethodologyService } from './methodology.service';
import { IncidentService } from '../services/incident.service';
import { PostmortemGeneratorService } from '../services/postmortemGenerator.service';
import { PartitionMaintenanceProvider } from '../db/partitionMaintenance.provider';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [OracleController],
  providers: [
    OracleService,
    OracleMonitorService,
    ClaimProcessorService,
    MethodologyRepository,
    MethodologyService,
    IncidentService,
    PostmortemGeneratorService,
    PartitionMaintenanceProvider,
  ],
  exports: [
    OracleService,
    OracleMonitorService,
    ClaimProcessorService,
    MethodologyRepository,
    MethodologyService,
    IncidentService,
    PostmortemGeneratorService,
    PartitionMaintenanceProvider,
  ],
})
export class OracleModule {}