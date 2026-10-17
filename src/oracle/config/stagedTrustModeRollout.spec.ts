import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StagedOracleTrustModeConfig } from "./stagedTrustModeRollout.ts";

describe("Staged Rollout Configuration for Oracle Trust Modes (#184)", () => {
  it("defaults unset coverage types to single_source and enforces mode-appropriate runtime quorum rules", () => {
    const policies = StagedOracleTrustModeConfig.resolveAndValidatePolicies({
      env: {
        ORACLE_TRUST_MODE_STABLECOIN_DEPEG: "corroborated",
        ORACLE_TRUST_MODE_PROTOCOL_EXPLOIT: "decentralized",
      },
      catalogPrerequisites: [
        {
          coverageType: "stablecoin-depeg",
          configuredSourceCount: 3,
          quorumMinimum: 2,
          registeredExternalIdentities: 0,
        },
        {
          coverageType: "protocol-exploit",
          configuredSourceCount: 3,
          quorumMinimum: 2,
          registeredExternalIdentities: 3,
        },
        {
          coverageType: "flight-delay",
          configuredSourceCount: 1,
          quorumMinimum: 1,
          registeredExternalIdentities: 0,
        },
      ],
    });

    const flightPolicy = policies.get("flight-delay")!;
    assert.equal(flightPolicy.trustMode, "single_source");
    assert.equal(
      StagedOracleTrustModeConfig.canPublishDecisionUnderPolicy({
        policy: flightPolicy,
        operatorPaused: false,
        agreeingSourceCount: 1,
        agreeingSignedExternalIdentities: 0,
      }).allowed,
      true
    );

    // Corroborated mode refuses to publish when only 1 source agrees (< quorumMinimum 2)
    const depegPolicy = policies.get("stablecoin-depeg")!;
    assert.equal(depegPolicy.trustMode, "corroborated");
    const blockedCorroborated =
      StagedOracleTrustModeConfig.canPublishDecisionUnderPolicy({
        policy: depegPolicy,
        operatorPaused: false,
        agreeingSourceCount: 1,
        agreeingSignedExternalIdentities: 0,
      });
    assert.equal(blockedCorroborated.allowed, false);
    assert.equal(
      blockedCorroborated.reasonCode,
      "CORROBORATION_QUORUM_NOT_MET"
    );

    // Decentralized mode requires signed external identities >= quorumMinimum
    const exploitPolicy = policies.get("protocol-exploit")!;
    assert.equal(exploitPolicy.trustMode, "decentralized");
    const blockedDecentralized =
      StagedOracleTrustModeConfig.canPublishDecisionUnderPolicy({
        policy: exploitPolicy,
        operatorPaused: false,
        agreeingSourceCount: 2,
        agreeingSignedExternalIdentities: 1,
      });
    assert.equal(blockedDecentralized.allowed, false);
    assert.equal(
      blockedDecentralized.reasonCode,
      "DECENTRALIZED_IDENTITY_QUORUM_NOT_MET"
    );
  });

  it("fails fast at startup on unknown coverage types, invalid trust modes, or unmet mode prerequisites", () => {
    assert.throws(
      () =>
        StagedOracleTrustModeConfig.resolveAndValidatePolicies({
          env: { ORACLE_TRUST_MODE_UNKNOWN_FEED: "corroborated" },
          catalogPrerequisites: [
            {
              coverageType: "stablecoin-depeg",
              configuredSourceCount: 3,
              quorumMinimum: 2,
              registeredExternalIdentities: 2,
            },
          ],
        }),
      /UNKNOWN_COVERAGE_TYPE_ENV/
    );

    assert.throws(
      () =>
        StagedOracleTrustModeConfig.resolveAndValidatePolicies({
          env: { ORACLE_TRUST_MODE_STABLECOIN_DEPEG: "corroborated" },
          catalogPrerequisites: [
            {
              coverageType: "stablecoin-depeg",
              configuredSourceCount: 1, // fewer than quorumMinimum 2
              quorumMinimum: 2,
              registeredExternalIdentities: 0,
            },
          ],
        }),
      /PREREQUISITE_NOT_MET_CORROBORATED_QUORUM/
    );

    assert.throws(
      () =>
        StagedOracleTrustModeConfig.resolveAndValidatePolicies({
          env: { ORACLE_TRUST_MODE_STABLECOIN_DEPEG: "decentralized" },
          catalogPrerequisites: [
            {
              coverageType: "stablecoin-depeg",
              configuredSourceCount: 3,
              quorumMinimum: 2,
              registeredExternalIdentities: 0, // zero registered external identities
            },
          ],
        }),
      /PREREQUISITE_NOT_MET_DECENTRALIZED_IDENTITIES/
    );
  });
});
