import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, WebSocket } from "ws";
import { OracleReading } from "./oracle-reading";

/**
 * Live oracle alert feed, reachable at `ws://<host>/` — same wire format
 * as the raw `ws` server the old src/index.ts ran directly. Nest's
 * WsAdapter (see src/main.ts) attaches this gateway to the same HTTP
 * server the REST API listens on, so no separate port is needed.
 */
@WebSocketGateway()
export class OracleGateway implements OnGatewayConnection {
  private readonly logger = new Logger(OracleGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: WebSocket): void {
    client.send(JSON.stringify({ type: "connected", message: "Refract oracle feed" }));
  }

  broadcastAlert(alert: OracleReading): void {
    const payload = JSON.stringify({ ...alert, timestamp: Date.now() });
    let sent = 0;
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent++;
      }
    }
    this.logger.debug(`Broadcast ${alert.coverageType} alert to ${sent} client(s)`);
  }
}
