import { Injectable } from '@nestjs/common';
import { ProtocolParameterKey } from './protocol-parameter-key.enum';

@Injectable()
export class ProtocolParametersService {
  async getNumber(key: ProtocolParameterKey): Promise<number> {
    const defaults: Record<ProtocolParameterKey, number> = {
      [ProtocolParameterKey.ORACLE_SCHEDULER_INTERVAL_SECONDS]: 60,
    };

    return defaults[key] ?? 60;
  }
}
