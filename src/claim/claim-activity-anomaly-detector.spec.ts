import {
  ClaimActivity,
  ClaimActivityAnomalyDetector,
  ClaimAnomalyConfig,
  PayoutBreaker,
} from './claim-activity-anomaly-detector';

const config: ClaimAnomalyConfig = {
  windowMs: 60_000,
  maximumSettlementVolumeByCoverage: { StablecoinDepeg: 1000 },
  maximumTriggersByCoverage: { StablecoinDepeg: 3 },
  maximumPolicyPayoutShare: 0.7,
  minimumPolicyVolumeForConcentration: 100,
  maximumObservations: 100,
};

function activity(overrides: Partial<ClaimActivity> = {}): ClaimActivity {
  return {
    claimId: 'claim-1',
    policyId: 'policy-1',
    coverageType: 'StablecoinDepeg',
    payout: 100,
    triggeredAt: 9_990,
    settledAt: 9_995,
    ...overrides,
  };
}

describe('ClaimActivityAnomalyDetector', () => {
  it('trips the payout breaker when normal individual readings accompany excessive volume', () => {
    const trip = jest.fn();
    const detector = new ClaimActivityAnomalyDetector(config, { trip });
    detector.record(activity({ payout: 600 }));
    detector.record(activity({ claimId: 'claim-2', policyId: 'policy-2', payout: 500 }));

    const anomalies = detector.evaluate(10_000);

    expect(anomalies.map((item) => item.code)).toContain('settlement_volume');
    expect(trip).toHaveBeenCalledWith(
      'StablecoinDepeg',
      expect.stringContaining('Settlement volume'),
      10_000,
    );
  });

  it('detects per-policy concentration and suppresses duplicate trips per window', () => {
    const trip = jest.fn();
    const detector = new ClaimActivityAnomalyDetector(config, { trip });
    detector.record(activity({ payout: 800 }));
    detector.record(activity({ claimId: 'claim-2', policyId: 'policy-2', payout: 200 }));

    const anomalies = detector.evaluate(10_000);
    expect(anomalies.map((item) => item.code)).toContain('policy_concentration');
    detector.evaluate(10_001);
    expect(
      trip.mock.calls.filter(([, reason]) =>
        String(reason).includes('accounts for'),
      ),
    ).toHaveLength(1);
  });

  it('detects excessive trigger frequency across coverage-specific thresholds', () => {
    const trip = jest.fn();
    const detector = new ClaimActivityAnomalyDetector(config, { trip });
    for (let index = 0; index < 4; index += 1) {
      detector.record(
        activity({
          claimId: `claim-${index}`,
          policyId: `policy-${index}`,
          payout: 0,
        }),
      );
    }

    const anomalies = detector.evaluate(10_000);
    expect(anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          coverageType: 'StablecoinDepeg',
          code: 'trigger_frequency',
          observed: 4,
          limit: 3,
        }),
      ]),
    );
  });

  it('ignores duplicate claims, expired activity, and stays within its memory bound', () => {
    const breaker: PayoutBreaker = { trip: jest.fn() };
    const detector = new ClaimActivityAnomalyDetector(
      { ...config, maximumObservations: 2 },
      breaker,
    );
    detector.record(activity({ claimId: 'duplicate', payout: 900 }));
    detector.record(activity({ claimId: 'duplicate', payout: 900 }));
    detector.record(activity({ claimId: 'second', policyId: 'policy-2', payout: 10 }));
    detector.record(activity({ claimId: 'third', policyId: 'policy-3', payout: 10 }));

    expect(detector.evaluate(100_000)).toEqual([]);
    expect(breaker.trip).not.toHaveBeenCalled();
  });
});
