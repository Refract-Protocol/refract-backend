import { rpc } from "@stellar/stellar-sdk";
import {
  DEFAULT_CONFIRMATION_POLL,
  pollForConfirmation,
} from "./soroban-confirmation.util";

function notFound(): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger: 1,
    latestLedgerCloseTime: 1,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
  };
}

function success(): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    latestLedger: 2,
    latestLedgerCloseTime: 2,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
    ledger: 2,
    createdAt: 2,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: {} as never,
    resultXdr: {} as never,
    resultMetaXdr: {} as never,
    returnValue: undefined,
  };
}

function failed(): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.FAILED,
    latestLedger: 2,
    latestLedgerCloseTime: 2,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
    ledger: 2,
    createdAt: 2,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: {} as never,
    resultXdr: {} as never,
    resultMetaXdr: {} as never,
  };
}

describe("pollForConfirmation", () => {
  it("returns success on the first SUCCESS response", async () => {
    const server = { getTransaction: jest.fn().mockResolvedValue(success()) } as unknown as rpc.Server;

    const result = await pollForConfirmation(server, "abc", {
      deadlineMs: 5_000,
      random: () => 0.5,
    });

    expect(result).toMatchObject({ confirmed: true, outcome: "success", txHash: "abc" });
    expect(server.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("maps FAILED to failed_on_chain", async () => {
    const server = { getTransaction: jest.fn().mockResolvedValue(failed()) } as unknown as rpc.Server;

    const result = await pollForConfirmation(server, "abc", { random: () => 0.5 });

    expect(result).toEqual({
      confirmed: false,
      outcome: "failed_on_chain",
      txHash: "abc",
      error: "Transaction failed on-chain",
    });
  });

  it("maps persistent NOT_FOUND past the deadline to not_found_yet_deadline_exceeded", async () => {
    const server = { getTransaction: jest.fn().mockResolvedValue(notFound()) } as unknown as rpc.Server;
    let now = 0;
    const sleeps: number[] = [];

    const result = await pollForConfirmation(server, "abc", {
      initialIntervalMs: 100,
      backoffMultiplier: 2,
      maxIntervalMs: 1_000,
      deadlineMs: 350,
      jitterRatio: 0,
      minIntervalMs: 1,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0.5,
    });

    expect(result.outcome).toBe("not_found_yet_deadline_exceeded");
    expect(result.error).toContain("Timed out");
    expect(sleeps.length).toBeGreaterThan(0);
    // Total waited must not exceed the wall-clock deadline.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(350);
  });

  it("grows the interval by the configured multiplier up to the max cap", async () => {
    const server = {
      getTransaction: jest
        .fn()
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(success()),
    } as unknown as rpc.Server;
    let now = 0;
    const sleeps: number[] = [];

    await pollForConfirmation(server, "abc", {
      initialIntervalMs: 100,
      backoffMultiplier: 2,
      maxIntervalMs: 250,
      deadlineMs: 10_000,
      jitterRatio: 0,
      minIntervalMs: 1,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0.5,
    });

    // After attempt 0 (immediate), sleeps: 100, then 200, then capped 250.
    expect(sleeps[0]).toBe(100);
    expect(sleeps[1]).toBe(200);
    expect(sleeps[2]).toBe(250);
  });

  it("retries a transient getTransaction throw inside the deadline", async () => {
    const server = {
      getTransaction: jest
        .fn()
        .mockRejectedValueOnce(new Error("RPC unavailable"))
        .mockResolvedValueOnce(success()),
    } as unknown as rpc.Server;
    let now = 0;

    const result = await pollForConfirmation(server, "abc", {
      initialIntervalMs: 50,
      deadlineMs: 5_000,
      jitterRatio: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      random: () => 0.5,
    });

    expect(result.outcome).toBe("success");
    expect(server.getTransaction).toHaveBeenCalledTimes(2);
  });

  it("stops promptly when the AbortSignal fires", async () => {
    const server = { getTransaction: jest.fn().mockResolvedValue(notFound()) } as unknown as rpc.Server;
    const controller = new AbortController();
    let now = 0;

    const resultPromise = pollForConfirmation(server, "abc", {
      initialIntervalMs: 100,
      deadlineMs: 30_000,
      jitterRatio: 0,
      signal: controller.signal,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        controller.abort();
      },
      random: () => 0.5,
    });

    const result = await resultPromise;
    expect(result.outcome).toBe("aborted");
    expect(result.error).toContain("aborted");
  });

  it("keeps jitter within ±jitterRatio of the base interval", async () => {
    const server = {
      getTransaction: jest.fn().mockResolvedValueOnce(notFound()).mockResolvedValueOnce(success()),
    } as unknown as rpc.Server;
    let now = 0;
    const sleeps: number[] = [];
    // random=1 → +jitter; random=0 → -jitter
    let flip = true;

    await pollForConfirmation(server, "abc", {
      initialIntervalMs: 1_000,
      deadlineMs: 10_000,
      jitterRatio: 0.2,
      minIntervalMs: 1,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => {
        flip = !flip;
        return flip ? 1 : 0;
      },
    });

    expect(sleeps[0]).toBeGreaterThanOrEqual(800);
    expect(sleeps[0]).toBeLessThanOrEqual(1_200);
  });

  it("exports documented defaults matching AppConfig", () => {
    expect(DEFAULT_CONFIRMATION_POLL.initialIntervalMs).toBe(400);
    expect(DEFAULT_CONFIRMATION_POLL.backoffMultiplier).toBe(1.8);
    expect(DEFAULT_CONFIRMATION_POLL.maxIntervalMs).toBe(8_000);
    expect(DEFAULT_CONFIRMATION_POLL.deadlineMs).toBe(30_000);
  });
});
