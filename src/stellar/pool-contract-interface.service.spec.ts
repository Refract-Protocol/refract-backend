import { contract, xdr } from "@stellar/stellar-sdk";
import { extractContractSpec, parseContractSpec, validatePoolContractSpec } from "./pool-contract-interface.service";

function unsignedLeb128(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function wasmWithCustomSection(name: string, contents: Buffer): Buffer {
  const sectionName = Buffer.from(name);
  const payload = Buffer.concat([unsignedLeb128(sectionName.length), sectionName, contents]);
  return Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.from([0]), unsignedLeb128(payload.length), payload]);
}

function processClaimEntry(): xdr.ScSpecEntry {
  const input = new xdr.ScSpecFunctionInputV0({
    doc: "",
    name: "policy_id",
    type: xdr.ScSpecTypeDef.scSpecTypeU64(),
  });
  const output = xdr.ScSpecTypeDef.scSpecTypeResult(
    new xdr.ScSpecTypeResult({
      okType: xdr.ScSpecTypeDef.scSpecTypeI128(),
      errorType: xdr.ScSpecTypeDef.scSpecTypeU32(),
    })
  );
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: "",
      name: "process_claim",
      inputs: [input],
      outputs: [output],
    })
  );
}

describe("pool contract interface validation", () => {
  it("extracts the Soroban contract spec custom section from WASM", () => {
    const specBytes = Buffer.from([1, 2, 3, 4]);

    expect(extractContractSpec(wasmWithCustomSection("contractspecv0", specBytes))).toEqual(specBytes);
  });

  it("rejects a WASM module without a contract spec", () => {
    expect(() => extractContractSpec(wasmWithCustomSection("name", Buffer.from("pool")))).toThrow(
      'does not contain the "contractspecv0" section'
    );
  });

  it("parses serialized contract spec entries from the WASM section", () => {
    const spec = parseContractSpec(wasmWithCustomSection("contractspecv0", processClaimEntry().toXDR()));

    expect(spec.getFunc("process_claim").inputs()[0].type().switch().name).toBe("scSpecTypeU64");
  });

  it("reports the confirmed process_claim argument mismatch in the deployed contract spec", () => {
    const errors = validatePoolContractSpec(new contract.Spec([processClaimEntry()]));

    expect(errors).toContain("process_claim arguments expected (policy_id:string, holder:address, payout:i128) but found (policy_id:u64)");
  });
});
