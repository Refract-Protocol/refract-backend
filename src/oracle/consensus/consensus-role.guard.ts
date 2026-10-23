import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "crypto";

/**
 * Roles for the consensus ops surface.
 * - `operator`: OPS_API_TOKEN. Full read/write (holds, governance, offboarding).
 * - `auditor`:  any token in AUDITOR_API_TOKENS (comma-separated). Read-only.
 */
export type ConsensusRole = "operator" | "auditor";

export const CONSENSUS_ROLES_KEY = "consensus:roles";
export const ConsensusRoles = (...roles: ConsensusRole[]) => SetMetadata(CONSENSUS_ROLES_KEY, roles);

export interface ConsensusRequest {
  headers: { authorization?: string };
  consensusRole?: ConsensusRole;
}

export function resolveConsensusRole(presented: string, env: NodeJS.ProcessEnv = process.env): ConsensusRole | null {
  const opsToken = env.OPS_API_TOKEN?.trim();
  if (opsToken && safeEqual(presented, opsToken)) return "operator";
  const auditors = (env.AUDITOR_API_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (auditors.some((t) => safeEqual(presented, t))) return "auditor";
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Bearer-token RBAC for consensus endpoints. Handlers declare the roles they
 * accept with @ConsensusRoles(); undecorated handlers default to operator-only.
 */
@Injectable()
export class ConsensusRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed =
      this.reflector.getAllAndOverride<ConsensusRole[] | undefined>(CONSENSUS_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? ["operator"];
    const req = context.switchToHttp().getRequest<ConsensusRequest>();
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const role = match ? resolveConsensusRole(match[1]) : null;
    if (!role) throw new UnauthorizedException({ error: "Invalid or missing bearer token" });
    if (!allowed.includes(role)) throw new ForbiddenException({ error: `Role ${role} may not perform this action` });
    req.consensusRole = role;
    return true;
  }
}
