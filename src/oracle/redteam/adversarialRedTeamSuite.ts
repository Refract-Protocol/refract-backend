export type AdversarialScenarioId =
  | "FORGED_UNSIGNED_SUBMISSION"
  | "REPLAYED_READING_ENVELOPE"
  | "MITM_SPOOFED_PROVIDER_PAYLOAD"
  | "COLLUDING_SOURCE_PAIR_ATTACK"
  | "ADMIN_PRIVILEGE_ESCALATION"
  | "COMPROMISED_RELAYER_KEY_ATTEMPT";

export type AdversarialSeverity = "critical" | "high" | "medium";
export type ExerciseEnvironment = "staging" | "simulation";

export interface ScenarioObservation {
  attackObserved: string;
  expectedBehavior: string;
  controlBlockedAttack: boolean;
  remediationOwner: string;
}

export interface ScenarioExecutor {
  environment: ExerciseEnvironment;
  executeAttack(): Promise<ScenarioObservation>;
  retest(): Promise<ScenarioObservation>;
}

export interface AdversarialFindingReport {
  scenarioId: AdversarialScenarioId;
  severity: AdversarialSeverity;
  reproductionSteps: string[];
  status: "verified" | "failed" | "blocked";
  environment?: ExerciseEnvironment;
  observedBehavior?: string;
  expectedBehavior: string;
  remediationOwner?: string;
  retestStatus: "passed" | "failed" | "not_run";
  blocker?: string;
}

interface ScenarioDefinition {
  severity: AdversarialSeverity;
  reproductionSteps: string[];
  expectedBehavior: string;
}

const SCENARIOS: Record<AdversarialScenarioId, ScenarioDefinition> = {
  FORGED_UNSIGNED_SUBMISSION: {
    severity: "critical",
    reproductionSteps: ["Submit a provider reading with no valid provider signature."],
    expectedBehavior: "Reject the submission before it enters consensus.",
  },
  REPLAYED_READING_ENVELOPE: {
    severity: "high",
    reproductionSteps: ["Replay an already accepted provider observation envelope."],
    expectedBehavior: "Accept at most one vote from that source and observation window.",
  },
  MITM_SPOOFED_PROVIDER_PAYLOAD: {
    severity: "high",
    reproductionSteps: [
      "In an isolated staging network, substitute a synthetic provider response with a false trigger value.",
    ],
    expectedBehavior: "Reject unauthenticated transport or quarantine the untrusted observation.",
  },
  COLLUDING_SOURCE_PAIR_ATTACK: {
    severity: "critical",
    reproductionSteps: [
      "Submit matching synthetic false values from two providers declared to share an independence group.",
    ],
    expectedBehavior: "Do not treat dependent providers as independent corroboration.",
  },
  ADMIN_PRIVILEGE_ESCALATION: {
    severity: "critical",
    reproductionSteps: ["Attempt a payout-affecting operator action using a read-only identity."],
    expectedBehavior: "Reject the action and record the authorization failure.",
  },
  COMPROMISED_RELAYER_KEY_ATTEMPT: {
    severity: "critical",
    reproductionSteps: [
      "In an isolated staging network, attempt a payout-affecting action with a synthetic revoked relayer identity.",
    ],
    expectedBehavior: "Reject or hold the action and emit an auditable security event.",
  },
};

/**
 * Runs only scenarios for which an explicit executor is supplied. This module
 * never fabricates observations or treats a local simulation as staging proof.
 */
export async function executeAdversarialRedTeamSuite(
  executors: Partial<Record<AdversarialScenarioId, ScenarioExecutor>> = {},
): Promise<{
  allHighSeverityClosed: boolean;
  findings: AdversarialFindingReport[];
}> {
  const findings: AdversarialFindingReport[] = [];

  for (const [scenarioId, definition] of Object.entries(SCENARIOS) as [
    AdversarialScenarioId,
    ScenarioDefinition,
  ][]) {
    const executor = executors[scenarioId];
    if (!executor) {
      findings.push({
        scenarioId,
        ...definition,
        status: "blocked",
        retestStatus: "not_run",
        blocker: "No authorized scenario executor was configured.",
      });
      continue;
    }

    try {
      const attack = await executor.executeAttack();
      const retest = await executor.retest();
      const expectedMatches =
        attack.expectedBehavior === definition.expectedBehavior &&
        retest.expectedBehavior === definition.expectedBehavior;
      const verified =
        executor.environment === "staging" &&
        expectedMatches &&
        attack.controlBlockedAttack &&
        retest.controlBlockedAttack;

      findings.push({
        scenarioId,
        ...definition,
        status: verified ? "verified" : "failed",
        environment: executor.environment,
        observedBehavior: attack.attackObserved,
        remediationOwner: attack.remediationOwner,
        retestStatus:
          expectedMatches && retest.controlBlockedAttack ? "passed" : "failed",
        blocker:
          executor.environment !== "staging"
            ? "Simulation results are not staging verification."
            : undefined,
      });
    } catch (error) {
      findings.push({
        scenarioId,
        ...definition,
        status: "failed",
        environment: executor.environment,
        retestStatus: "not_run",
        blocker: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    allHighSeverityClosed: findings.every(
      (finding) =>
        finding.status === "verified" &&
        finding.retestStatus === "passed",
    ),
    findings,
  };
}
