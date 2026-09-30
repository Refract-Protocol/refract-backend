/**
 * @deprecated Import from `../common/coverage-type.map` directly.
 * This barrel re-export is kept only to avoid breaking the existing
 * quote.service.ts and create-quote.dto.ts import paths during the
 * transition period.
 *
 * CoverageTypeName is now a `const` value object (not an enum) exported
 * from the unified mapping module. It is usable both as a value (e.g.
 * `@IsEnum(CoverageTypeName)`, `CoverageTypeName.StablecoinDepeg`) and as
 * a type via `CoverageTypeSoroban` or `typeof CoverageTypeName[keyof typeof CoverageTypeName]`.
 */
export { CoverageTypeName } from "../common/coverage-type.map";
