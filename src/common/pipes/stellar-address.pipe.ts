import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { normalizeStrKey } from '../validators/stellar-address.validator';

/**
 * Validates a Stellar ed25519 public key (`G...`) path parameter before it
 * reaches any service or RPC call.
 *
 * `@Param()` values do not go through DTO validation, so this pipe is applied
 * explicitly to every `:address` route parameter. Muxed accounts (`M...`) are
 * rejected because they are not valid contract-invocation sources.
 *
 * Input is trimmed and uppercased before validation, and the normalized value
 * is returned so downstream code always sees the canonical form.
 */
@Injectable()
export class StellarAddressPipe implements PipeTransform<string, string> {
  transform(value: string, _metadata: ArgumentMetadata): string {
    if (typeof value !== 'string') {
      throw new BadRequestException('address must be a string');
    }

    const address = normalizeStrKey(value);

    if (address.length !== 56) {
      throw new BadRequestException('address must be exactly 56 characters long');
    }

    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new BadRequestException(
        'address is not a valid Stellar public key (bad version byte or checksum)',
      );
    }

    return address;
  }
}
