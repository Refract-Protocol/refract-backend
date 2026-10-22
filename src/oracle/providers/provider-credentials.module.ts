import { Module } from "@nestjs/common";
import { CredentialRepository } from "./credential.repository";
import { ProviderCredentialService } from "./provider-credential.service";
import { OpsProviderController } from "./ops-provider.controller";
import { DatabaseModule } from "../../database/database.module";

/**
 * Provides provider identity management, versioned API key lifecycle,
 * revocation, rotation, and forensic reporting for oracle providers.
 */
@Module({
  imports: [DatabaseModule],
  providers: [CredentialRepository, ProviderCredentialService],
  controllers: [OpsProviderController],
  exports: [ProviderCredentialService],
})
export class ProviderCredentialsModule {}
