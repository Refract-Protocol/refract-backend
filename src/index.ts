import { config } from './config';
import { logger } from './utils/logger';
import { OracleMonitor } from './services/oracleMonitor';
import { HeartbeatService } from './services/heartbeat';

async function main(): Promise<void> {
  logger.info('Starting oracle pipeline');

  const monitor = new OracleMonitor(config);
  const heartbeat = new HeartbeatService(config);

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down oracle pipeline');
    try {
      await monitor.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping oracle monitor');
    }
    try {
      await heartbeat.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping heartbeat service');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // Register the completed-work hook. The heartbeat is driven exclusively by
  // successful cycle completions (poll + DB write), not by a standalone timer,
  // so a wedged loop stops heartbeating by construction.
  monitor.onCycleComplete(async (result) => {
    if (shuttingDown) {
      return;
    }
    try {
      await heartbeat.recordCompletedCycle({
        feedCount: result.feedCount,
        successfulFeedCount: result.successfulFeedCount,
        lastSuccessfulPublishAt: result.lastSuccessfulPublishAt,
      });
    } catch (err) {
      // Heartbeat failures must never block ingestion or settlement.
      logger.error({ err }, 'Heartbeat completed-cycle signal failed');
    }
  });

  try {
    await heartbeat.start();
  } catch (err) {
    logger.error({ err }, 'Failed to start heartbeat service');
  }

  try {
    await monitor.start();
  } catch (err) {
    logger.error({ err }, 'Fatal error in oracle monitor');
    await shutdown('fatal');
    return;
  }
}

main().catch((err) => {
  logger.error({ err }, 'Unhandled fatal error');
  process.exit(1);
});