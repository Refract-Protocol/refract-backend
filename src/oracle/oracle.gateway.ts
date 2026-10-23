import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnModuleDestroy,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, Optional } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';
import { Server, WebSocket } from 'ws';
import { TrustEventsService } from './trust-events.service';
import {
  TRUST_CHANNELS,
  TRUST_SCHEMA_VERSION,
  TrustChannel,
  TrustEnvelope,
  redactEnvelope,
} from './trust-events';

const MAX_QUEUE = Number(process.env.WS_MAX_QUEUE ?? 100);
const HIGH_WATER_BYTES = Number(process.env.WS_HIGH_WATER_BYTES ?? 64 * 1024);
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS ?? 30_000);
const FLUSH_MS = 50;

interface ClientState {
  authed: boolean;
  channels: Set<TrustChannel>;
  coverageTypes: Set<string>;
  queue: string[];
  resync: boolean;
  alive: boolean;
}

@WebSocketGateway({ path: '/oracle' })
export class OracleGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(OracleGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private unsubscribe?: () => void;
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;

  @WebSocketServer()
  server: Server;

  constructor(@Optional() private readonly trust?: TrustEventsService) {
    this.unsubscribe = this.trust?.onEvent((e) => this.broadcast(e));
  }

  handleConnection(client: WebSocket, req?: IncomingMessage): void {
    this.logger.log('Oracle WebSocket client connected');
    const state: ClientState = {
      authed: this.isAuthed(req),
      channels: new Set(TRUST_CHANNELS),
      coverageTypes: new Set(),
      queue: [],
      resync: false,
      alive: true,
    };
    this.clients.set(client, state);
    this.startTimers();

    client.on('error', (err) => {
      this.logger.warn(`Oracle WebSocket client error: ${err.message}`);
    });
    client.on('pong', () => {
      state.alive = true;
    });
    client.on('message', (data) => this.onMessage(client, state, data.toString()));

    // Snapshot first, so clients need no racing REST bootstrap.
    this.safeSend(client, {
      type: 'snapshot',
      version: TRUST_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      events: (this.trust?.getSnapshot() ?? [])
        .filter((e) => this.matches(state, e))
        .map((e) => this.view(state, e)),
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.logger.log('Oracle WebSocket client disconnected');
  }

  /** Authenticated (ops) clients present `?token=` equal to OPS_WS_TOKEN. */
  private isAuthed(req?: IncomingMessage): boolean {
    const expected = process.env.OPS_WS_TOKEN;
    if (!expected || !req?.url) return false;
    const token =
      new URL(req.url, 'http://localhost').searchParams.get('token') ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Client messages: {"action":"subscribe","channels":[...],"coverageTypes":[...]}
   * (empty/omitted channels = all; omitted coverageTypes = all) and "unsubscribe".
   */
  private onMessage(client: WebSocket, state: ClientState, raw: string): void {
    let msg: { action?: string; channels?: unknown; coverageTypes?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.safeSend(client, { type: 'error', message: 'invalid JSON' });
    }
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    if (msg.action === 'subscribe') {
      const channels = strings(msg.channels).filter((c): c is TrustChannel =>
        (TRUST_CHANNELS as readonly string[]).includes(c),
      );
      state.channels = new Set(channels.length ? channels : TRUST_CHANNELS);
      state.coverageTypes = new Set(strings(msg.coverageTypes).slice(0, 64));
      this.safeSend(client, { type: 'subscribed', channels: [...state.channels] });
    } else if (msg.action === 'unsubscribe') {
      for (const c of strings(msg.channels)) state.channels.delete(c as TrustChannel);
    }
  }

  private view(state: ClientState, e: TrustEnvelope): TrustEnvelope {
    return state.authed ? e : redactEnvelope(e);
  }

  private matches(state: ClientState, e: TrustEnvelope): boolean {
    if (!state.channels.has(e.type)) return false;
    const ct = e.payload.coverageType;
    return (
      state.coverageTypes.size === 0 ||
      typeof ct !== 'string' ||
      state.coverageTypes.has(ct)
    );
  }

  private broadcast(event: TrustEnvelope): void {
    for (const [client, state] of this.clients) {
      if (!this.matches(state, event)) continue;
      state.queue.push(JSON.stringify(this.view(state, event)));
      if (state.queue.length > MAX_QUEUE) {
        state.queue.shift(); // drop-oldest
        state.resync = true;
      }
      this.flush(client, state);
    }
  }

  /** Drains the bounded queue while the socket buffer is under the high-water mark. */
  private flush(client: WebSocket, state: ClientState): void {
    if (client.readyState !== WebSocket.OPEN) return;
    while (state.queue.length && client.bufferedAmount < HIGH_WATER_BYTES) {
      client.send(state.queue.shift() as string);
    }
    if (state.resync && state.queue.length === 0) {
      state.resync = false;
      this.safeSend(client, { type: 'resync_required' });
    }
  }

  private safeSend(client: WebSocket, msg: unknown): void {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify(msg));
    } catch (err) {
      this.logger.warn(`Failed to send: ${(err as Error).message}`);
    }
  }

  private startTimers(): void {
    this.flushTimer ??= setInterval(() => {
      for (const [c, s] of this.clients) if (s.queue.length) this.flush(c, s);
    }, FLUSH_MS);
    this.heartbeatTimer ??= setInterval(() => {
      for (const [c, s] of this.clients) {
        if (!s.alive) {
          c.terminate();
          this.clients.delete(c);
          continue;
        }
        s.alive = false;
        c.ping();
      }
    }, HEARTBEAT_MS);
    this.flushTimer.unref();
    this.heartbeatTimer.unref();
  }

  /**
   * Graceful shutdown: send a proper close frame to every connected client
   * before the shared HTTP server stops accepting connections. Dropping the
   * socket without a close frame would leave clients unable to distinguish a
   * clean shutdown from a network failure.
   */
  onModuleDestroy(): void {
    this.unsubscribe?.();
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);

    if (!this.server) {
      return;
    }

    const clients = this.server.clients;
    if (!clients || clients.size === 0) {
      return;
    }

    this.logger.log(
      `Closing ${clients.size} Oracle WebSocket client(s) during shutdown`,
    );

    for (const client of clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch (err) {
        this.logger.warn(
          `Failed to close Oracle WebSocket client: ${(err as Error).message}`,
        );
      }
    }
  }
}
