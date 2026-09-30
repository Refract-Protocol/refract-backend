import { Injectable, OnApplicationShutdown, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class CacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const url = this.configService.get<string>('REDIS_URL');
    this.client = url
      ? new Redis(url, { lazyConnect: false })
      : new Redis({
          host: this.configService.get<string>('REDIS_HOST', 'localhost'),
          port: this.configService.get<number>('REDIS_PORT', 6379),
          password: this.configService.get<string>('REDIS_PASSWORD'),
        });

    this.client.on('error', (err) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Gracefully close the Redis connection pool during application shutdown.
   * Called by Nest when `app.enableShutdownHooks()` is active and the process
   * receives SIGTERM/SIGINT, ensuring in-flight commands drain before exit.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Closing Redis connection pool${signal ? ` (signal: ${signal})` : ''}...`,
    );
    try {
      await this.client.quit();
      this.logger.log('Redis connection pool closed cleanly.');
    } catch (err) {
      this.logger.error(
        `Failed to close Redis connection pool cleanly: ${(err as Error).message}`,
      );
      this.client.disconnect();
    }
  }
}
