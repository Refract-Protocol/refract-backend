import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { cereal, contract, rpc, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

interface ExpectedFunction {
  args: string[];
  result: string;
}

const EXPECTED_FUNCTIONS: Record<string, ExpectedFunction> = {
  buy_policy: { args: ["holder:address", "params:udt:PolicyParams"], result: "result:u64" },
  provide_capital: { args: ["provider:address", "amount:i128"], result: "result:i128" },
  withdraw_capital: { args: ["provider:address", "shares:i128"], result: "result:i128" },
  process_claim: { args: ["policy_id:string", "holder:address", "payout:i128"], result: "result:i128" },
  pool_config: { args: [], result: "option:udt:PoolConfig" },
  lockup_expires_at: { args: ["provider:address"], result: "option:u64" },
};

const EXPECTED_STRUCT_FIELDS: Record<string, Record<string, string>> = {
  PolicyParams: {
    coverage_amount: "i128",
    coverage_type: "udt:CoverageType",
    duration_days: "u32",
    trigger_threshold: "i128",
  },
  PoolConfig: {
    min_coverage: "i128",
    max_coverage: "i128",
  },
};

const EXPECTED_ENUM_VARIANTS: Record<string, string[]> = {
  CoverageType: ["StablecoinDepeg", "MarketCrash", "LiquidationShield", "SmartContractRisk", "FlightDelay"],
};

function describeType(type: xdr.ScSpecTypeDef): string {
  const kind = type.switch().name;
  if (kind === "scSpecTypeUdt") return `udt:${type.udt().name()}`;
  if (kind === "scSpecTypeOption") return `option:${describeType(type.option().valueType())}`;
  if (kind === "scSpecTypeResult") return `result:${describeType(type.result().okType())}`;
  return kind.replace(/^scSpecType/, "").toLowerCase();
}

function readUnsignedLeb128(bytes: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift < 35) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  throw new Error("Invalid WebAssembly section length");
}

export function extractContractSpec(wasm: Buffer): Buffer {
  if (wasm.length < 8 || wasm.subarray(0, 4).toString("hex") !== "0061736d") {
    throw new Error("Pool contract response is not a WebAssembly module");
  }

  let offset = 8;
  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const sectionLength = readUnsignedLeb128(wasm, offset);
    offset = sectionLength.next;
    const sectionEnd = offset + sectionLength.value;
    if (sectionEnd > wasm.length) throw new Error("Truncated WebAssembly section");

    if (sectionId === 0) {
      const nameLength = readUnsignedLeb128(wasm, offset);
      const nameEnd = nameLength.next + nameLength.value;
      if (nameEnd > sectionEnd) throw new Error("Truncated WebAssembly custom section name");
      const name = wasm.subarray(nameLength.next, nameEnd).toString("utf8");
      if (name === "contractspecv0") return wasm.subarray(nameEnd, sectionEnd);
    }
    offset = sectionEnd;
  }
  throw new Error('Pool contract WASM does not contain the "contractspecv0" section');
}

export function validatePoolContractSpec(spec: contract.Spec): string[] {
  const errors: string[] = [];

  for (const [name, expected] of Object.entries(EXPECTED_FUNCTIONS)) {
    let actual: ReturnType<contract.Spec["getFunc"]>;
    try {
      actual = spec.getFunc(name);
    } catch {
      errors.push(`missing function ${name}`);
      continue;
    }

    const args = actual.inputs().map((input) => `${input.name()}:${describeType(input.type())}`);
    if (args.join(",") !== expected.args.join(",")) {
      errors.push(`${name} arguments expected (${expected.args.join(", ")}) but found (${args.join(", ")})`);
    }

    const outputs = actual.outputs();
    const result = outputs.length === 1 ? describeType(outputs[0]) : outputs.length === 0 ? "void" : "multiple";
    if (result !== expected.result) {
      errors.push(`${name} result expected ${expected.result} but found ${result}`);
    }
  }

  for (const [name, expectedFields] of Object.entries(EXPECTED_STRUCT_FIELDS)) {
    const entry = spec.entries.find(
      (candidate) => candidate.switch().name === "scSpecEntryUdtStructV0" && candidate.udtStructV0().name() === name
    );
    if (!entry) {
      errors.push(`missing struct ${name}`);
      continue;
    }

    const actualFields = new Map(
      entry.udtStructV0().fields().map((field) => [field.name().toString(), describeType(field.type())])
    );
    for (const [fieldName, expectedType] of Object.entries(expectedFields)) {
      const actualType = actualFields.get(fieldName);
      if (actualType !== expectedType) {
        errors.push(`${name}.${fieldName} expected ${expectedType} but found ${actualType ?? "missing"}`);
      }
    }
  }

  for (const [name, expectedVariants] of Object.entries(EXPECTED_ENUM_VARIANTS)) {
    const entry = spec.entries.find(
      (candidate) => candidate.switch().name === "scSpecEntryUdtEnumV0" && candidate.udtEnumV0().name() === name
    );
    if (!entry) {
      errors.push(`missing enum ${name}`);
      continue;
    }

    const variants = entry.udtEnumV0().cases().map((variant) => variant.name().toString());
    if (variants.join(",") !== expectedVariants.join(",")) {
      errors.push(`${name} variants expected (${expectedVariants.join(", ")}) but found (${variants.join(", ")})`);
    }
  }

  return errors;
}

export function parseContractSpec(wasm: Buffer): contract.Spec {
  const reader = new cereal.XdrReader(extractContractSpec(wasm));
  const entries: xdr.ScSpecEntry[] = [];
  while (!reader.eof) entries.push(xdr.ScSpecEntry.read(reader as never));
  return new contract.Spec(entries);
}

@Injectable()
export class PoolContractInterfaceService implements OnModuleInit {
  private readonly logger = new Logger(PoolContractInterfaceService.name);
  private readonly server: rpc.Server;
  private readonly network: AppConfig["stellar"]["network"];
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(configService: ConfigService<AppConfig, true>) {
    const stellar = configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.network = stellar.network;
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
  }

  async onModuleInit(): Promise<void> {
    if (!this.poolContractId) {
      this.logger.warn("Skipping live pool contract interface validation: no pool contract ID is configured");
      return;
    }

    try {
      const network = await this.server.getNetwork();
      if (network.passphrase !== this.networkPassphrase) {
        throw new Error(
          `RPC network passphrase mismatch for ${this.network}: expected "${this.networkPassphrase}", found "${network.passphrase}"`
        );
      }

      const wasm = await this.server.getContractWasmByContractId(this.poolContractId);
      const errors = validatePoolContractSpec(parseContractSpec(wasm));
      if (errors.length > 0) {
        throw new Error(`Pool contract interface mismatch:\n- ${errors.join("\n- ")}`);
      }
      this.logger.log(`Validated pool contract interface against ${this.network} contract ${this.poolContractId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Stellar pool contract validation failed: ${message}`);
    }
  }
}
