import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { OracleSandboxService, REGISTRATION_MESSAGE_VERSION, SandboxInputError } from "./oracle-sandbox.service";
import { READING_MESSAGE_VERSION } from "./provider-submission";

const clampLimit = (raw?: string): number => {
  const n = Number(raw ?? 50);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
};

/**
 * Provider sandbox API. Mounted only when ORACLE_SANDBOX_MODE=true.
 *
 *   GET  /sandbox/oracle                    feeds, policy, signing format
 *   POST /sandbox/oracle/providers          register a provider key (signed)
 *   GET  /sandbox/oracle/providers
 *   POST /sandbox/oracle/readings           submit a signed reading
 *   GET  /sandbox/oracle/feeds/:feed        readings in the current window
 *   GET  /sandbox/oracle/decisions[?feed=]  consensus decisions, newest first
 *   GET  /sandbox/oracle/decisions/:id
 *   GET  /sandbox/oracle/rejections[?providerId=&feed=]
 */
@Controller("sandbox/oracle")
export class OracleSandboxController {
  constructor(private readonly sandbox: OracleSandboxService) {}

  @Get()
  describe() {
    return {
      mode: "sandbox",
      publishesOnChain: false,
      feeds: this.sandbox.feeds(),
      policy: this.sandbox.policy(),
      signing: {
        algorithm: "ed25519 (Stellar keypair), base64 signature over the UTF-8 message",
        readingMessage: [READING_MESSAGE_VERSION, "sandbox", "<providerId>", "<feed>", "<value>", "<observedAt>", "<nonce>"].join("\\n"),
        registrationMessage: [REGISTRATION_MESSAGE_VERSION, "sandbox", "<providerId>", "<name>"].join("\\n"),
      },
    };
  }

  @Post("providers")
  @HttpCode(201)
  register(@Body() body: unknown) {
    try {
      return this.sandbox.registerProvider(body);
    } catch (err) {
      if (err instanceof SandboxInputError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get("providers")
  providers() {
    return this.sandbox.listProviders();
  }

  /**
   * Always 202, even for rejected readings: the trace in the body is what
   * the provider reads to see what happened.
   */
  @Post("readings")
  @HttpCode(202)
  submit(@Body() body: unknown) {
    return this.sandbox.submit(body);
  }

  @Get("feeds/:feed")
  feed(@Param("feed") feed: string) {
    if (!this.sandbox.feeds().includes(feed)) throw new NotFoundException(`Unknown feed "${feed}"`);
    return this.sandbox.feedState(feed);
  }

  @Get("decisions")
  decisions(@Query("feed") feed?: string, @Query("limit") limit?: string) {
    return this.sandbox.listDecisions(feed, clampLimit(limit));
  }

  @Get("decisions/:id")
  decision(@Param("id") id: string) {
    const decision = this.sandbox.getDecision(id);
    if (!decision) throw new NotFoundException("Decision not found");
    return decision;
  }

  @Get("rejections")
  rejections(
    @Query("providerId") providerId?: string,
    @Query("feed") feed?: string,
    @Query("limit") limit?: string,
  ) {
    return this.sandbox.listRejections({ providerId, feed }, clampLimit(limit));
  }
}
