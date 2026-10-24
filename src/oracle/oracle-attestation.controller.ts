import { Controller, Get } from "@nestjs/common";
import { OracleAttestationService } from "./oracle-attestation.service";

@Controller("api/v1/oracle")
export class OracleAttestationController {
  constructor(private readonly attestations: OracleAttestationService) {}

  @Get("verification-keys")
  getVerificationKeys() {
    return {
      version: 1,
      keys: this.attestations.getVerificationKeys(),
    };
  }
}
