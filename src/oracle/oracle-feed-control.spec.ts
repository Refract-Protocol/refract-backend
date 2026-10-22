import {
  OnChainPausePublisher,
  OracleFeedControl,
} from './oracle-feed-control';

describe('OracleFeedControl', () => {
  it('enforces a local pause before and despite failed on-chain publication', async () => {
    const publisher: OnChainPausePublisher = {
      publishPause: jest
        .fn()
        .mockRejectedValue(new Error('RPC unavailable')),
    };
    const control = new OracleFeedControl(publisher);

    const state = await control.pause('*', 'trust engine trip', 10);

    expect(state.paused).toBe(true);
    expect(state.onChainStatus).toBe('unconfirmed');
    expect(control.isPaused('MarketCrash')).toBe(true);
  });

  it('does not clear a local pause until chain resume is confirmed', async () => {
    const publishPause = jest
      .fn()
      .mockResolvedValueOnce({ confirmed: true, txHash: 'pause-tx' })
      .mockResolvedValueOnce({ confirmed: false, txHash: 'resume-pending' });
    const control = new OracleFeedControl({ publishPause });

    await control.pause('StablecoinDepeg', 'incident', 10);
    await expect(control.resume('StablecoinDepeg', 20)).rejects.toThrow(
      'not confirmed',
    );
    expect(control.isPaused('StablecoinDepeg')).toBe(true);
  });

  it('requires a configured chain publisher to resume a paused feed', async () => {
    const control = new OracleFeedControl();
    await control.pause('MarketCrash', 'trip', 10);

    await expect(control.resume('MarketCrash', 20)).rejects.toThrow(
      'without an on-chain pause publisher',
    );
    expect(control.isPaused('MarketCrash')).toBe(true);
  });

  it('supports a confirmed global resume and returns copied snapshots', async () => {
    const publishPause = jest
      .fn()
      .mockResolvedValue({ confirmed: true, txHash: 'control-tx' });
    const control = new OracleFeedControl({ publishPause });
    await control.pause('*', 'global trip', 10);
    const resumed = await control.resume('*', 20);

    expect(resumed.paused).toBe(false);
    expect(resumed.onChainStatus).toBe('confirmed');
    expect(control.isPaused('FlightDelay')).toBe(false);
    resumed.reason = 'mutated';
    expect(control.getSnapshot('*').reason).toBeNull();
  });
});
