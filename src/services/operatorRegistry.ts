import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { z } from "zod";
import { PG_POOL } from "../db/db.module";

export const OPERATOR_STATUSES = ["pending", "active", "suspended", "exited"] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];

/** `exited` is terminal. Everything else must go through this table. */
const ALLOWED_TRANSITIONS: Record<OperatorStatus, OperatorStatus[]> = {
  pending: ["active", "exited"],
  active: ["suspended", "exited"],
  suspended: ["active", "exited"],
  exited: [],
};

/** Registration requests whose timestamp is further than this from now are rejected. */
export const REGISTRATION_WINDOW_MS = 5 * 60 * 1000;

export const RegisterOperatorSchema = z.object({
  submissionKey: z.string().regex(/^G[A-Z2-7]{55}$/, "submissionKey must be a Stellar public key"),
  supportedFeeds: z.array(z.string().min(1).max(64)).min(1).max(32),
  nonce: z.string().min(16).max(128),
  timestamp: z.number().int().positive(),
  signature: z.string().base64(),
});
export type RegisterOperatorDto = z.infer<typeof RegisterOperatorSchema>;

export const SetOperatorStatusSchema = z.object({
  status: z.enum(OPERATOR_STATUSES),
  actor: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
});
export type SetOperatorStatusDto = z.infer<typeof SetOperatorStatusSchema>;

/**
 * The exact bytes the operator signs. Feeds are sorted so the signature does
 * not depend on the order the client lists them in.
 */
export function registrationMessage(dto: Omit<RegisterOperatorDto, "signature">): string {
  return [
    "refract-operator-register",
    dto.submissionKey,
    [...dto.supportedFeeds].sort().join(","),
    dto.nonce,
    String(dto.timestamp),
  ].join("\n");
}

export function verifyRegistrationSignature(dto: RegisterOperatorDto): boolean {
  try {
    const keypair = Keypair.fromPublicKey(dto.submissionKey);
    return keypair.verify(
      Buffer.from(registrationMessage(dto), "utf8"),
      Buffer.from(dto.signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Quorum counting for one feed in one window. An operator counts once no
 * matter how many readings it submitted, and only `active` operators count.
 * Suspended operators' readings are still recorded upstream but never reach
 * this function's quorum.
 */
export function countQuorumOperators(
  readings: ReadonlyArray<{ operatorId: string; status: OperatorStatus }>,
): number {
  return new Set(
    readings.filter((reading) => reading.status === "active").map((reading) => reading.operatorId),
  ).size;
}

export function meetsOperatorQuorum(
  readings: ReadonlyArray<{ operatorId: string; status: OperatorStatus }>,
  required: number,
): boolean {
  return countQuorumOperators(readings) >= required;
}

@Injectable()
export class OperatorRegistryService {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Verifies a signed registration request and records the operator as
   * `pending`. Activation happens after the on-chain registration is confirmed.
   */
  async register(body: unknown): Promise<{ id: string; status: OperatorStatus; registeredAt: Date }> {
    const parsed = RegisterOperatorSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const dto = parsed.data;

    if (Math.abs(Date.now() - dto.timestamp) > REGISTRATION_WINDOW_MS) {
      throw new UnauthorizedException("registration timestamp is outside the accepted window");
    }
    if (!verifyRegistrationSignature(dto)) {
      throw new UnauthorizedException("signature does not verify against submissionKey");
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operator_registration_nonces (submission_key, nonce) VALUES ($1, $2)`,
        [dto.submissionKey, dto.nonce],
      ).catch((err) => {
        throw isUniqueViolation(err, "operator_registration_nonces")
          ? new ConflictException("registration request has already been used")
          : err;
      });

      const { rows } = await client.query<{ id: string; status: OperatorStatus; registered_at: Date }>(
        `INSERT INTO operators (submission_key, supported_feeds)
         VALUES ($1, $2)
         RETURNING id, status, registered_at`,
        [dto.submissionKey, dto.supportedFeeds],
      ).catch((err) => {
        throw isUniqueViolation(err, "operators")
          ? new ConflictException("submission key is already registered")
          : err;
      });
      const operator = rows[0];

      await client.query(
        `INSERT INTO operator_audit (operator_id, event, to_status, actor, reason)
         VALUES ($1, 'registered', $2, 'self', NULL)`,
        [operator.id, operator.status],
      );
      await client.query("COMMIT");

      return { id: operator.id, status: operator.status, registeredAt: operator.registered_at };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Moves an operator to a new status and writes an audit row in the same
   * transaction. Row lock prevents two concurrent status changes from both
   * passing the transition check.
   */
  async setStatus(operatorId: string, body: unknown): Promise<{ id: string; status: OperatorStatus }> {
    const parsed = SetOperatorStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const { status: next, actor, reason } = parsed.data;

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ status: OperatorStatus }>(
        `SELECT status FROM operators WHERE id = $1 FOR UPDATE`,
        [operatorId],
      );
      if (rows.length === 0) {
        throw new NotFoundException("operator not found");
      }
      const current = rows[0].status;
      if (!ALLOWED_TRANSITIONS[current].includes(next)) {
        throw new ConflictException(`invalid status transition ${current} -> ${next}`);
      }

      await client.query(
        `UPDATE operators SET status = $2, updated_at = now() WHERE id = $1`,
        [operatorId, next],
      );
      await client.query(
        `INSERT INTO operator_audit (operator_id, event, from_status, to_status, actor, reason)
         VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
        [operatorId, current, next, actor, reason ?? null],
      );
      await client.query("COMMIT");

      return { id: operatorId, status: next };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

function isUniqueViolation(err: unknown, table: string): boolean {
  const pgErr = err as { code?: string; table?: string };
  return pgErr.code === "23505" && pgErr.table === table;
}
