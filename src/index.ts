import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import winston from "winston";

import { policiesRouter } from "./routes/policies";
import { poolRouter } from "./routes/pool";
import { quotesRouter } from "./routes/quotes";
import { OracleMonitor } from "./services/oracleMonitor";
import { ClaimProcessor } from "./services/claimProcessor";

dotenv.config();

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level}: ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3001" }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", protocol: "Refract" }));
app.use("/api/v1/policies", policiesRouter);
app.use("/api/v1/pool", poolRouter);
app.use("/api/v1/quotes", quotesRouter);

// ── WebSocket: broadcast oracle alerts ───────────────────────────────────────
const alertSubscribers = new Set<WebSocket>();

wss.on("connection", (ws) => {
  alertSubscribers.add(ws);
  ws.on("close", () => alertSubscribers.delete(ws));
  ws.send(JSON.stringify({ type: "connected", message: "Refract oracle feed" }));
});

export function broadcastAlert(alert: {
  type: string;
  coverageType: string;
  severity: "low" | "medium" | "high" | "triggered";
  value: number;
  threshold: number;
  message: string;
}) {
  const payload = JSON.stringify({ ...alert, timestamp: Date.now() });
  for (const client of alertSubscribers) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// ── Services ──────────────────────────────────────────────────────────────────
const oracleMonitor = new OracleMonitor();
const claimProcessor = new ClaimProcessor();

async function startServices() {
  logger.info("🔮 Starting Refract oracle monitor...");

  // Oracle monitor: check prices every 60 seconds
  setInterval(async () => {
    try {
      const readings = await oracleMonitor.checkAll();
      for (const r of readings) {
        if (r.severity !== "low") {
          broadcastAlert(r);
          logger.warn(`⚠️  Oracle alert: ${r.coverageType} — ${r.message}`);
        }
      }
    } catch (err) {
      logger.error("Oracle monitor error", err);
    }
  }, 60_000);

  // Claim processor: auto-process triggered policies every 5 minutes
  setInterval(async () => {
    try {
      const processed = await claimProcessor.processTriggered();
      if (processed.length > 0) {
        logger.info(`💰 Auto-processed ${processed.length} claims`);
      }
    } catch (err) {
      logger.error("Claim processor error", err);
    }
  }, 300_000);

  logger.info("✅ Refract services running");
}

const PORT = parseInt(process.env.PORT || "4001");
server.listen(PORT, () => {
  logger.info(`🛡️  Refract API listening on :${PORT}`);
  startServices();
});

export default app;
