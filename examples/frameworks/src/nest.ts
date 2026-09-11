import "reflect-metadata";

import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  Res,
  type DynamicModule,
  type RawBodyRequest,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";

import { handleWebhook, type Ledger } from "./webhook.js";
import type { RunningApp } from "./running.js";

/**
 * NestJS 12 on its default Express platform.
 *
 * Nest has the raw body built in: create the app with `rawBody: true` and the
 * request gains `rawBody`, a `Buffer` of what was sent, *alongside* the parsed
 * `body` - so the rest of the application is unaffected. Without the flag,
 * `rawBody` is simply undefined, which is why the handler checks for it.
 */

/**
 * Injected by token rather than by type. Nest's type-based injection reads
 * `emitDecoratorMetadata` output, which esbuild - and so Vitest, tsx and most
 * modern tooling - does not produce. An explicit token works under every
 * compiler, so a recipe that is going to be copied should use one.
 */
export const LEDGER = Symbol("Ledger");

@Controller("webhooks")
class WebhookController {
  constructor(@Inject(LEDGER) private readonly ledger: Ledger) {}

  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-signature") signature: string | undefined,
    @Res() response: Response,
  ): void {
    const raw = request.rawBody ?? Buffer.alloc(0);
    const result = handleWebhook(this.ledger, raw, signature);
    // @Res() hands the response to us, so the status set here is final; the
    // @HttpCode above only documents the success case.
    response.status(result.status).json(result.body);
  }
}

@Module({})
class WebhookModule {
  static forLedger(ledger: Ledger): DynamicModule {
    return {
      module: WebhookModule,
      controllers: [WebhookController],
      providers: [{ provide: LEDGER, useValue: ledger }],
    };
  }
}

/**
 * Listens on an ephemeral loopback port.
 *
 * `app.listen(0, host)` then `getUrl()`, which reports the bound address.
 * `logger: false` keeps Nest's startup banner out of the test output; drop it
 * while debugging a recipe that will not start.
 */
export async function startNest(ledger: Ledger): Promise<RunningApp> {
  const app = await NestFactory.create(WebhookModule.forLedger(ledger), {
    rawBody: true,
    logger: false,
  });
  await app.listen(0, "127.0.0.1");

  return {
    baseUrl: await app.getUrl(),
    close: () => app.close(),
  };
}
