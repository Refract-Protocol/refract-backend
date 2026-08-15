import { WebSocket } from "ws";
import { OracleGateway } from "./oracle.gateway";
import { OracleReading } from "./oracle-reading";

function buildReading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 1.0,
    threshold: 0.95,
    severity: "low",
    message: "USDC price: $1.0000",
    ...overrides,
  };
}

function mockClient(readyState: number, sendImpl?: () => void): WebSocket {
  return { readyState, send: jest.fn(sendImpl) } as unknown as WebSocket;
}

describe("OracleGateway", () => {
  describe("handleConnection", () => {
    it("sends a connected message to the new client", () => {
      const gateway = new OracleGateway();
      const client = mockClient(WebSocket.OPEN);

      gateway.handleConnection(client);

      expect(client.send).toHaveBeenCalledWith(expect.stringContaining("Refract oracle feed"));
    });
  });

  describe("broadcastAlert", () => {
    it("sends the alert to every open client and skips closed ones", () => {
      const gateway = new OracleGateway();
      const open1 = mockClient(WebSocket.OPEN);
      const open2 = mockClient(WebSocket.OPEN);
      const closed = mockClient(WebSocket.CLOSED);
      gateway.server = { clients: new Set([open1, open2, closed]) } as unknown as OracleGateway["server"];

      gateway.broadcastAlert(buildReading());

      expect(open1.send).toHaveBeenCalledTimes(1);
      expect(open2.send).toHaveBeenCalledTimes(1);
      expect(closed.send).not.toHaveBeenCalled();
    });

    it("does not let one client's send() throw stop the broadcast to the rest", () => {
      const gateway = new OracleGateway();
      const throwing = mockClient(WebSocket.OPEN, () => {
        throw new Error("socket closing");
      });
      const healthy = mockClient(WebSocket.OPEN);
      gateway.server = { clients: new Set([throwing, healthy]) } as unknown as OracleGateway["server"];

      expect(() => gateway.broadcastAlert(buildReading())).not.toThrow();
      expect(healthy.send).toHaveBeenCalledTimes(1);
    });
  });
});
