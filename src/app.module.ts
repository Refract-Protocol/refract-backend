import { Module } from '@nestjs/common';
import { SecurityReportsModule } from './security-reports/security-reports.module';

@Module({
  imports: [SecurityReportsModule],
})
export class AppModule {}
