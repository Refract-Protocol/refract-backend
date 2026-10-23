import { OracleRecoveryGate } from './oracle-recovery-gate';
import { OracleReading } from './oracle-reading';

const reading = (overrides: Partial<OracleReading> = {}): OracleReading => ({
  coverageType: 'StablecoinDepeg',
  type: 'oracle_update',
  value: 1,
  threshold: 0.95,
  severity: 'low',
  message: 'healthy',
  ...overrides,
});

describe('OracleRecoveryGate', () => {
  const config = {
    cooldownMs: 100,
    healthyReadingsToGraduate: 3,
    minimumCanaryDurationMs: 200,
    minimumCorroboratingPeers: 2,
  };

  it('holds after a trip, then only computes readings during canary recovery', () => {
    const gate = new OracleRecoveryGate(config);
    gate.trip('StablecoinDepeg', 'anomaly', 1_000);

    expect(gate.admit(reading(), 3, 1_099)).toBe('hold');
    expect(gate.admit(reading(), 3, 1_100)).toBe('canary');
    expect(gate.admit(reading(), 3, 1_200)).toBe('canary');
    expect(gate.admit(reading(), 3, 1_300)).toBe('canary');
    expect(gate.getState('StablecoinDepeg').mode).toBe('normal');
    expect(gate.admit(reading(), 3, 1_301)).toBe('publish');
  });

  it('reopens the breaker if canary corroboration is lost', () => {
    const gate = new OracleRecoveryGate(config);
    gate.trip('StablecoinDepeg', 'anomaly', 0);
    expect(gate.admit(reading(), 2, 100)).toBe('canary');
    expect(gate.admit(reading(), 1, 150)).toBe('hold');
    expect(gate.getState('StablecoinDepeg').mode).toBe('open');
  });

  it('trips on degraded or triggering readings and isolates coverage types', () => {
    const gate = new OracleRecoveryGate(config);
    expect(gate.admit(reading({ severity: 'triggered' }), 2, 1_000)).toBe('hold');
    expect(gate.getState('StablecoinDepeg').mode).toBe('open');
    expect(gate.admit(reading({ coverageType: 'MarketCrash' }), 2, 1_000)).toBe(
      'publish',
    );
  });

  it('requires strictly increasing observation times during canary', () => {
    const gate = new OracleRecoveryGate(config);
    gate.trip('StablecoinDepeg', 'anomaly', 0);
    expect(gate.admit(reading(), 2, 100)).toBe('canary');
    expect(gate.admit(reading(), 2, 100)).toBe('hold');
  });
});
