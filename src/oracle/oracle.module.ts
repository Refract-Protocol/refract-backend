import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { OracleService } from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleMonitorService } from '../services/oracleMonitor';
import { FreshnessEnforcementService } from './freshness/freshnessEnforcement.service';
import { FeedCalendarResolver } from './calendar/feedCalendarResolver';
import { ClockService } from './calendar/clock.service';
import { FeedCalendarConfigService } from './calendar/feedCalendarConfig.service';
import { HolidayCalendarSource } from './calendar/holidayCalendarSource';
import { AttestationVerifierRegistry } from './attestation/attestationVerifierRegistry';
import { AttestationVerifier } from './attestation/attestationVerifier.interface';
import { NitroEnclaveAttestationVerifier } from './attestation/nitroEnclaveAttestationVerifier';
import { SgxAttestationVerifier } from './attestation/sgxAttestationVerifier';
import { AttestationPolicyService } from './attestation/attestationPolicy.service';
import { AttestationTierService } from './attestation/attestationTier.service';
import { SourceIndependenceService } from './weighting/sourceIndependence.service';
import { ORACLE_CLOCK, ORACLE_CALENDAR_RESOLVER } from './oracle.tokens';

const clockProvider: Provider = {
  provide: ORACLE_CLOCK,
  useFactory: (configService: ConfigService) => {
    return new ClockService(configService);
  },
  inject: [ConfigService],
};

const calendarResolverProvider: Provider = {
  provide: ORACLE_CALENDAR_RESOLVER,
  useFactory: (
    configService: ConfigService,
    clock: ClockService,
    holidaySource: HolidayCalendarSource,
    configServiceForFeeds: FeedCalendarConfigService,
  ) => {
    return new FeedCalendarResolver(
      configService,
      clock,
      holidaySource,
      configServiceForFeeds,
    );
  },
  inject: [
    ConfigService,
    ClockService,
    HolidayCalendarSource,
    FeedCalendarConfigService,
  ],
};

const attestationVerifierProvider: Provider = {
  provide: AttestationVerifierRegistry,
  useFactory: (
    configService: ConfigService,
    nitroVerifier: NitroEnclaveAttestationVerifier,
    sgxVerifier: SgxAttestationVerifier,
  ): AttestationVerifierRegistry => {
    const registry = new AttestationVerifierRegistry(configService);
    const verifiers: AttestationVerifier[] = [nitroVerifier, sgxVerifier];
    for (const verifier of verifiers) {
      registry.register(verifier);
    }
    return registry;
  },
  inject: [ConfigService, NitroEnclaveAttestationVerifier, SgxAttestationVerifier],
};

@Module({
  imports: [ConfigModule],
  controllers: [OracleController],
  providers: [
    // Clock & calendar abstraction (issue #291)
    ClockService,
    clockProvider,
    FeedCalendarConfigService,
    HolidayCalendarSource,
    FeedCalendarResolver,
    calendarResolverProvider,

    // TEE attestation verifiers (issue #293)
    NitroEnclaveAttestationVerifier,
    SgxAttestationVerifier,
    AttestationVerifierRegistry,
    attestationVerifierProvider,
    AttestationPolicyService,
    AttestationTierService,

    // Weighting
    SourceIndependenceService,

    // Core oracle services
    OracleService,
    OracleMonitorService,
    FreshnessEnforcementService,
  ],
  exports: [
    OracleService,
    OracleMonitorService,
    FreshnessEnforcementService,
    ClockService,
    ORACLE_CLOCK,
    FeedCalendarResolver,
    ORACLE_CALENDAR_RESOLVER,
    AttestationVerifierRegistry,
    AttestationPolicyService,
    AttestationTierService,
    SourceIndependenceService,
  ],
})
export class OracleModule {}