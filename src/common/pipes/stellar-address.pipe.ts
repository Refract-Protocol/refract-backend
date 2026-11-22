import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Validates a Stellar ed25519 public key (`G...`) path parameter before it
 * reaches any service or RPC call.
 *
 * `@Param()` values do not go through DTO validation, so this pipe is applied
 * explicitly to every `:address` route parameter. Muxed accounts (`M...`) are
 * rejected because they are not valid contract-invocation sources.
 */
@Injectable()
export class StellarAddressPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    // Screen readers announce the message verbatim, so it must name the field.
    const field = metadata.data ?? 'address';
    const message = `${field} must be a valid Stellar address`;

    if (typeof value !== 'string' || value.length !== 56) {
      throw new BadRequestException(message);
    }

    if (!StrKey.isValidEd25519PublicKey(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }
}
