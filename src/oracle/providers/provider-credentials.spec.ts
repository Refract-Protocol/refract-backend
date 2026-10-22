/**
 * Tests for provider credential lifecycle:
 *   1. Revoked keys are rejected at the submission boundary
 *   2. Overlap-window rotation accepts both keys, then only the new one
 *   3. Affected-decision report correctness
 *   4. Accidental-revocation reversal
 */
import { NotFoundException, UnauthorizedException, ConflictException, BadRequestException } from "@nestjs/common";
import { ProviderCredentialService } from "./provider-credential.service";
import { CredentialRepository } from "./credential.repository";
import { generateRawKey, hashKey, ProviderIdentity, ProviderKey, RevocationRecord } from "./credentials";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    id: "provider-1",
    name: "TestProvider",
    contact: "test@example.com",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeKey(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: "key-1",
    providerId: "provider-1",
    keyHash: hashKey("rawsecret"),
    version: 1,
    status: "active",
    createdAt: new Date(),
    rotatingAt: null,
    revokedAt: null,
    effectiveUntilSequence: null,
    ...overrides,
  };
}

function makeRevocation(overrides: Partial<RevocationRecord> = {}): RevocationRecord {
  return {
    id: "rev-1",
    keyId: "key-1",
    providerId: "provider-1",
    reason: "Key leaked",
    actor: "admin",
    effectiveFromSequence: 1000,
    revokedAt: new Date(),
    supersedesRevocationId: null,
    ...overrides,
  };
}

function buildMockRepo(overrides: Partial<CredentialRepository> = {}): jest.Mocked<CredentialRepository> {
  return {
    createProvider: jest.fn(),
    getProvider: jest.fn(),
    listProviders: jest.fn(),
    createKey: jest.fn(),
    getKey: jest.fn(),
    listKeysByProvider: jest.fn(),
    getAcceptableKeys: jest.fn(),
    updateKeyStatus: jest.fn(),
    recordRevocation: jest.fn(),
    getRevocationsForKey: jest.fn(),
    getRevocationsForProvider: jest.fn(),
    recordRotation: jest.fn(),
    completeRotation: jest.fn(),
    getActiveRotation: jest.fn(),
    findAffectedEvents: jest.fn(),
    findAffectedClaims: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<CredentialRepository>;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("ProviderCredentialService", () => {
  let service: ProviderCredentialService;
  let repo: jest.Mocked<CredentialRepository>;

  beforeEach(() => {
    repo = buildMockRepo();
    service = new ProviderCredentialService(repo);
  });

  // ── 1. Revoked keys are rejected at submission boundary ───────────────────

  describe("validateSubmission", () => {
    it("accepts a valid active key", async () => {
      const rawKey = "rawsecret";
      const key = makeKey({ keyHash: hashKey(rawKey) });
      repo.getAcceptableKeys.mockResolvedValue([key]);

      const result = await service.validateSubmission("provider-1", rawKey);
      expect(result).toEqual(key);
    });

    it("rejects when no acceptable keys exist (all revoked)", async () => {
      repo.getAcceptableKeys.mockResolvedValue([]);
      await expect(
        service.validateSubmission("provider-1", "any-raw-key"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects a key that does not match any acceptable key hash", async () => {
      const key = makeKey({ keyHash: hashKey("correct-secret") });
      repo.getAcceptableKeys.mockResolvedValue([key]);

      await expect(
        service.validateSubmission("provider-1", "wrong-secret"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("accepts a rotating key during the overlap window", async () => {
      const rawKey = "rotating-secret";
      const rotatingKey = makeKey({ keyHash: hashKey(rawKey), status: "rotating" });
      repo.getAcceptableKeys.mockResolvedValue([rotatingKey]);

      const result = await service.validateSubmission("provider-1", rawKey);
      expect(result.status).toBe("rotating");
    });
  });

  // ── 2. Overlap-window rotation: both keys accepted, then only new ─────────

  describe("initiateRotation + completeRotation", () => {
    it("issues a new key and puts old key into rotating state", async () => {
      const provider = makeProvider();
      const oldKey = makeKey({ id: "key-1", version: 1, status: "active" });
      const newKey = makeKey({ id: "key-2", version: 2, status: "active" });

      repo.getProvider.mockResolvedValue(provider);
      repo.getActiveRotation.mockResolvedValue(null);
      repo.listKeysByProvider.mockResolvedValue([oldKey]);
      repo.createKey.mockResolvedValue(newKey);
      repo.updateKeyStatus.mockResolvedValue(undefined);
      repo.recordRotation.mockResolvedValue({
        id: "rot-1",
        providerId: "provider-1",
        oldKeyId: "key-1",
        newKeyId: "key-2",
        overlapWindowEndsAt: new Date(Date.now() + 300_000),
        actor: "admin",
        initiatedAt: new Date(),
        completedAt: null,
      });

      const result = await service.initiateRotation({
        providerId: "provider-1",
        actor: "admin",
        overlapWindowSeconds: 300,
      });

      expect(result.rawKey).toBeTruthy();
      expect(result.oldKey.id).toBe("key-1");
      expect(result.newKey.id).toBe("key-2");
      // Old key is marked rotating
      expect(repo.updateKeyStatus).toHaveBeenCalledWith(
        "key-1", "rotating", expect.objectContaining({ rotatingAt: expect.any(Date) }),
      );
    });

    it("rejects rotation when one is already in-progress", async () => {
      const provider = makeProvider();
      repo.getProvider.mockResolvedValue(provider);
      repo.getActiveRotation.mockResolvedValue({
        id: "rot-existing",
        providerId: "provider-1",
        oldKeyId: "key-1",
        newKeyId: "key-2",
        overlapWindowEndsAt: new Date(),
        actor: "admin",
        initiatedAt: new Date(),
        completedAt: null,
      });

      await expect(
        service.initiateRotation({ providerId: "provider-1", actor: "admin" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("completeRotation supersedes the old key", async () => {
      repo.getActiveRotation.mockResolvedValue({
        id: "rot-1",
        providerId: "provider-1",
        oldKeyId: "key-1",
        newKeyId: "key-2",
        overlapWindowEndsAt: new Date(),
        actor: "admin",
        initiatedAt: new Date(),
        completedAt: null,
      });
      repo.updateKeyStatus.mockResolvedValue(undefined);
      repo.completeRotation.mockResolvedValue(undefined);

      await service.completeRotation({ providerId: "provider-1", actor: "admin" });

      expect(repo.updateKeyStatus).toHaveBeenCalledWith(
        "key-1", "superseded", expect.anything(),
      );
      expect(repo.completeRotation).toHaveBeenCalledWith("rot-1");
    });

    it("after completeRotation, only the new key is accepted", async () => {
      // Simulate post-completion: getAcceptableKeys returns only the new key
      const newRaw = "new-raw-key";
      const newKey = makeKey({ id: "key-2", keyHash: hashKey(newRaw), version: 2, status: "active" });
      repo.getAcceptableKeys.mockResolvedValue([newKey]);

      // Old key is rejected
      await expect(
        service.validateSubmission("provider-1", "old-raw-key"),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // New key is accepted
      const result = await service.validateSubmission("provider-1", newRaw);
      expect(result.id).toBe("key-2");
    });
  });

  // ── 3. Affected-decision report correctness ───────────────────────────────

  describe("revokeKey — forensic report", () => {
    it("generates a forensic report with affected events and claims", async () => {
      const key = makeKey({ status: "active" });
      const provider = makeProvider();
      const revocation = makeRevocation();

      repo.getKey.mockResolvedValue(key);
      repo.getProvider.mockResolvedValue(provider);
      repo.updateKeyStatus.mockResolvedValue(undefined);
      repo.recordRevocation.mockResolvedValue(revocation);
      repo.findAffectedEvents.mockResolvedValue([
        { id: BigInt(1), coverageType: "stablecoin_depeg", value: 0.9950, source: "TestProvider", recordedAt: new Date() },
      ]);
      repo.findAffectedClaims.mockResolvedValue([
        { id: "claim-1", policyId: "policy-1", coverageType: "stablecoin_depeg", triggerSource: "TestProvider", processedAt: new Date() },
      ]);

      const report = await service.revokeKey({
        keyId: "key-1",
        reason: "Key leaked in incident #42",
        actor: "ops-admin",
        effectiveFromSequence: 1000,
        lookbackSeconds: 3600,
      });

      expect(report.affectedEvents).toHaveLength(1);
      expect(report.affectedClaims).toHaveLength(1);
      expect(report.revocation.reason).toBe("Key leaked in incident #42");
      expect(report.generatedAt).toBeInstanceOf(Date);
    });

    it("throws if key not found", async () => {
      repo.getKey.mockResolvedValue(null);
      await expect(
        service.revokeKey({ keyId: "missing", reason: "x", actor: "a", effectiveFromSequence: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws ConflictException if key is already revoked", async () => {
      repo.getKey.mockResolvedValue(makeKey({ status: "revoked" }));
      await expect(
        service.revokeKey({ keyId: "key-1", reason: "x", actor: "a", effectiveFromSequence: 0 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── 4. Accidental-revocation reversal ─────────────────────────────────────

  describe("reverseRevocation", () => {
    it("restores key to active and inserts superseding record", async () => {
      const revokedKey = makeKey({ status: "revoked" });
      const supersedingRecord = makeRevocation({
        id: "rev-2",
        supersedesRevocationId: "rev-1",
      });

      repo.getKey.mockResolvedValue(revokedKey);
      repo.updateKeyStatus.mockResolvedValue(undefined);
      repo.recordRevocation.mockResolvedValue(supersedingRecord);

      const result = await service.reverseRevocation({
        keyId: "key-1",
        supersedesRevocationId: "rev-1",
        reason: "Revocation was made in error",
        actor: "ops-admin",
        effectiveFromSequence: 1001,
      });

      // Key status restored to active
      expect(repo.updateKeyStatus).toHaveBeenCalledWith(
        "key-1", "active", expect.anything(),
      );
      // Superseding record created
      expect(repo.recordRevocation).toHaveBeenCalledWith(
        expect.objectContaining({ supersedesRevocationId: "rev-1" }),
      );
      expect(result.supersedesRevocationId).toBe("rev-1");
    });

    it("throws BadRequestException if key is not currently revoked", async () => {
      repo.getKey.mockResolvedValue(makeKey({ status: "active" }));
      await expect(
        service.reverseRevocation({
          keyId: "key-1",
          supersedesRevocationId: "rev-1",
          reason: "error",
          actor: "admin",
          effectiveFromSequence: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws NotFoundException if key does not exist", async () => {
      repo.getKey.mockResolvedValue(null);
      await expect(
        service.reverseRevocation({
          keyId: "missing",
          supersedesRevocationId: "rev-1",
          reason: "error",
          actor: "admin",
          effectiveFromSequence: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Credential helpers ────────────────────────────────────────────────────

  describe("generateRawKey / hashKey / verifyKey", () => {
    it("generates unique keys", () => {
      const a = generateRawKey();
      const b = generateRawKey();
      expect(a).not.toBe(b);
      expect(a).toHaveLength(64); // 32 bytes hex
    });

    it("verifyKey returns true for matching key/hash", () => {
      const { verifyKey } = require("./credentials");
      const raw = generateRawKey();
      const hash = hashKey(raw);
      expect(verifyKey(raw, hash)).toBe(true);
    });

    it("verifyKey returns false for wrong key", () => {
      const { verifyKey } = require("./credentials");
      const raw = generateRawKey();
      const hash = hashKey(raw);
      expect(verifyKey("wrong" + raw, hash)).toBe(false);
    });
  });
});
