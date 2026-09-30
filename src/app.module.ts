import { Module } from '@nestjs/common';
import { SecurityReportsModule } from './security-reports/security-reports.module';
import { DigestModule } from './digest/digest.module';

@Module({
  imports: [SecurityReportsModule, DigestModule],
})
export class AppModule {}
