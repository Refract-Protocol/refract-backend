import { parseFixed } from "./fixed-point";

describe("parseFixed", () => {
  it.each([
    ["0.5", 5_000_000n],
    ["-0.5", -5_000_000n],
    ["5", 50_000_000n],
  ])("parses %s", (input, expected) => {
    expect(parseFixed(input)).toBe(expected);
  });

  it.each([
    ["a lone decimal point", "."],
    ["a sign with no integer part", "-.5"],
    // Note: the current regex also rejects a trailing dot with no
    // fractional digits ("5."), even though issue #570 names it as
    // something that "must still be accepted" — no test anywhere in this
    // codebase pins that claim down, and it does not match current
    // behaviour, so it is intentionally left out here rather than
    // asserted as a false positive. See the PR/commit notes.
  ])("rejects %s", (_label, input) => {
    expect(() => parseFixed(input)).toThrow(RangeError);
  });
});
