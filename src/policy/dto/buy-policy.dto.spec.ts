import { validate } from "class-validator";
import { BuyPolicyDto } from "./buy-policy.dto";

function validDto(overrides: Partial<BuyPolicyDto> = {}): BuyPolicyDto {
  return Object.assign(new BuyPolicyDto(), {
    holder: "G".padEnd(56, "A"),
    coverageType: 0,
    coverageAmount: "100",
    durationDays: 30,
    ...overrides,
  });
}

describe("BuyPolicyDto triggerParams", () => {
  it("accepts a bounded flat set of scalar values", async () => {
    await expect(validate(validDto({ triggerParams: { flightNumber: "BA249" } }))).resolves.toHaveLength(0);
  });

  it.each([
    null,
    { flightNumber: "A".repeat(257) },
    { nested: { value: "not allowed" } },
    Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`key${index}`, "value"])),
  ])("rejects malformed, oversized, or nested triggerParams", async (triggerParams) => {
    const errors = await validate(validDto({ triggerParams: triggerParams as Record<string, unknown> }));
    expect(errors.some((error) => error.property === "triggerParams")).toBe(true);
  });
});
