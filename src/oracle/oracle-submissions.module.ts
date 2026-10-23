import { Module } from "@nestjs/common";
import { OracleSubmissionsController } from "./oracle-submissions.controller";
import { OracleSubmissionRepository } from "./oracle-submission.repository";
import { SubmissionVerifier } from "./submission-verifier";

/**
 * Signed third-party submission intake. DbService must be provided globally
 * (as for the stellar indexer cursor) so the repository can reach Postgres.
 */
@Module({
  controllers: [OracleSubmissionsController],
  providers: [SubmissionVerifier, OracleSubmissionRepository],
  exports: [SubmissionVerifier, OracleSubmissionRepository],
})
export class OracleSubmissionsModule {}
