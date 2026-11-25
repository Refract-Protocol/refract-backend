import { ValidationArguments } from "class-validator";
import { CoverageTypeName } from "../../quote/coverage-type";
import { CoverageLimitsConstraint } from "./coverage-limits.validator";

const constraint = new CoverageLimitsConstraint();

function argsFor(object: Record<string, unknown>): ValidationArguments {
  return { object, value: undefined, targetName: "", property: "coverageAmount", constraints: [] };
}

describe("CoverageLimitsConstraint", () => {
  it.each([0, -1, -100])("rejects a coverageAmount of %s regardless of the catalog minimum", (coverageAmount) => {
    const args = argsFor({ coverageType: CoverageTypeName.StablecoinDepeg, coverageAmount, durationDays: 1 });

    expect(constraint.validate(undefined, args)).toBe(false);
    expect(constraint.defaultMessage(args)).toBe("coverageAmount must be greater than 0");
  });

  it("still accepts a coverageAmount within the catalog's allowed range", () => {
    const args = argsFor({ coverageType: CoverageTypeName.StablecoinDepeg, coverageAmount: 500, durationDays: 1 });

    expect(constraint.validate(undefined, args)).toBe(true);
  });

  it("still rejects a positive coverageAmount above the catalog's max", () => {
    const args = argsFor({ coverageType: CoverageTypeName.StablecoinDepeg, coverageAmount: 10_000_000, durationDays: 1 });

    expect(constraint.validate(undefined, args)).toBe(false);
  });
});
