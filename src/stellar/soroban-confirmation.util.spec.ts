import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeI128ReturnValue, pollForConfirmation } from "./soroban-confirmation.util";
import { rpc } from "@stellar/stellar-sdk";

describe("decodeI128ReturnValue", () => {
  it("decodes zero", () => {
    const val = nativeToScVal(0n, { type: "i128" });
    expect(decodeI128ReturnValue(val)).toBe(0n);
  });

  it("decodes negative values", () => {
    const val = nativeToScVal(-42n, { type: "i128" });
    expect(decodeI128ReturnValue(val)).toBe(-42n);
  });

  it("decodes values larger than 2^53 without precision loss", () => {
    const large = 9_007_199_254_740_993n; // 2^53 + 1
    const val = nativeToScVal(large, { type: "i128" });
    expect(decodeI128ReturnValue(val)).toBe(large);
  });

  it("returns null when returnValue is missing", () => {
    expect(decodeI128ReturnValue(undefined)).toBeNull();
  });

  it("throws when the contract returned a structured error", () => {
    const errVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("error"),
        val: xdr.ScVal.scvU32(6),
      }),
    ]);
    expect(() => decodeI128ReturnValue(errVal)).toThrow(/Contract returned an error result/);
  });
});

describe("pollForConfirmation", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns returnValue on SUCCESS", async () => {
    jest.useFakeTimers();
    const returnValue = nativeToScVal(100n, { type: "i128" });
    const getTransaction = jest.fn().mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue,
    });

    const result = await pollForConfirmation({ getTransaction }, "abc123");

    expect(result.confirmed).toBe(true);
    expect(result.returnValue).toBe(returnValue);
  });
});
