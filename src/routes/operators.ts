import { Body, Controller, Module, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { OpsAuthGuard } from "../common/guards/ops-auth.guard";
import { OperatorRegistryService } from "../services/operatorRegistry";

@Controller("api/v1/operators")
export class OperatorsController {
  constructor(private readonly registry: OperatorRegistryService) {}

  /** Public: the signed request body is the credential. */
  @Post("register")
  register(@Body() body: unknown) {
    return this.registry.register(body);
  }

  @Patch(":id/status")
  @UseGuards(OpsAuthGuard)
  setStatus(@Param("id") id: string, @Body() body: unknown) {
    return this.registry.setStatus(id, body);
  }
}

@Module({
  controllers: [OperatorsController],
  providers: [OperatorRegistryService],
  exports: [OperatorRegistryService],
})
export class OperatorsModule {}
