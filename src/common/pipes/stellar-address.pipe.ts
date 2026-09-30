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
  transform(value: string, _metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || value.length !== 56) {
      throw new BadRequestException('address must be exactly 56 characters long');
    }

    if (!StrKey.isValidEd25519PublicKey(value)) {
      throw new BadRequestException(
        'address is not a valid Stellar public key (bad version byte or checksum)',
      );
    }

    return value;
  }
}
