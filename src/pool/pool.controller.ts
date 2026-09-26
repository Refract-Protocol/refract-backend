import { Controller, Get, UseInterceptors, ClassSerializerInterceptor } from '@nestjs/common';
import { PoolService } from './pool.service';
import { PoolStatsResponseDto } from './dto/pool-stats.response';

@Controller('pool')
@UseInterceptors(ClassSerializerInterceptor)
export class PoolController {
  constructor(private readonly poolService: PoolService) {}

  @Get('stats')
  async getStats(): Promise<PoolStatsResponseDto> {
    const stats = await this.poolService.getStats();
    return PoolStatsResponseDto.from(stats);
  }
}
