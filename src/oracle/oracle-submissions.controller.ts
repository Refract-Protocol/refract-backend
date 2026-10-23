import { Body, ConflictException, Controller, Post } from "@nestjs/common";
import { OracleSubmissionRepository } from "./oracle-submission.repository";
import { SubmissionVerifier } from "./submission-verifier";

@Controller("api/v1/oracle/submissions")
export class OracleSubmissionsController {
  constructor(
    private readonly verifier: SubmissionVerifier,
    private readonly repository: OracleSubmissionRepository,
  ) {}

  /**
   * Accepts a reading signed by a registered data provider. Authentication is
   * the detached Ed25519 signature, so no API key is required. See
   * docs/oracle-submissions.md for the canonical payload and error codes.
   */
  @Post()
  async submit(@Body() body: unknown) {
    const submission = this.verifier.verify(body);

    const recorded = await this.repository.recordIfNonceUnused(submission);
    if (!recorded) {
      throw new ConflictException({
        code: "REPLAYED_NONCE",
        error: "This nonce was already used by this provider",
      });
    }

    return {
      accepted: true,
      providerId: submission.providerId,
      coverageType: submission.coverageType,
      observedAt: submission.observedAt.toISOString(),
      nonce: submission.nonce,
    };
  }
}
