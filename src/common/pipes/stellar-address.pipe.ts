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
    // The parameter's own name, so a route with more than one address says
    // WHICH one was rejected. A form showing the message next to the wrong
    // field, or reading "address is invalid" aloud when the page has three,
    // leaves the user to guess. `data` is undefined only for a bare
    // `@Param()`, where "address" remains the honest description.
    const field = metadata.data ?? 'address';

    if (typeof value !== 'string' || value.length !== 56) {
      throw new BadRequestException(
        `${field} must be exactly 56 characters long (a Stellar public key, starting with G)`,
      );
    }

    if (!StrKey.isValidEd25519PublicKey(value)) {
      throw new BadRequestException(
        `${field} is not a valid Stellar public key (bad version byte or checksum)`,
      );
    }

    return value;
  }
}
