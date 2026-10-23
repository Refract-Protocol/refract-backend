import { Global, Module } from '@nestjs/common';
import { AlertingModule } from '../alerting/alerting.module';
import { LeaderElector } from './leader-elector.service';

/**
 * LeaderModule is @Global so the oracle and claim schedulers can gate their
 * side-effecting work on leadership without importing it per feature module.
 */
@Global()
@Module({
  imports: [AlertingModule],
  providers: [LeaderElector],
  exports: [LeaderElector],
})
export class LeaderModule {}
