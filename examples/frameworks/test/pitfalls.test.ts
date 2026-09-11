import { describe, expect, it } from "vitest";

import express from "express";

import { listenExpress } from "../src/express.js";
import { handleWebhook, type Ledger } from "../src/webhook.js";
import { deliverDuplicates, statusesOf } from "./scenario.js";

/**
 * The two mistakes the Express recipe's comments warn about, made on purpose.
 *
 * A warning in a comment is a claim like any other. These show each one
 * happening, and show how EventLab reports it: every delivery refused, and the
 * default `all-2xx` expectation failing the run - before any business
 * assertion gets the chance to be confusing about why nothing was fulfilled.
 *
 * Both are Express-shaped, but the first is the same mistake in every
 * framework: reach for the parsed body when the signature is over the bytes.
 */
describe("raw-body pitfalls, shown failing", () => {
  it("verifying a re-serialised body refuses every genuine delivery", async () => {
    const start = (ledger: Ledger) => {
      const app = express();
      app.post("/webhooks", express.json(), (request, response) => {
        // The mistake: sign-check what JSON.stringify makes of the parsed
        // body. It matches only when the provider sent compact JSON with the
        // same key order - and this provider pretty-prints.
        const reserialised = Buffer.from(JSON.stringify(request.body));
        const result = handleWebhook(ledger, reserialised, request.header("x-signature"));
        response.status(result.status).json(result.body);
      });
      return listenExpress(app);
    };

    const { report, ledger } = await deliverDuplicates(start);

    expect(report.passed).toBe(false);
    expect(statusesOf(report)).toEqual(Array(9).fill(401));
    expect(ledger.handled).toBe(0);
  });

  it("an app-wide express.json() mounted first starves the raw route", async () => {
    const start = (ledger: Ledger) => {
      const app = express();
      // The mistake: the usual app-wide parser, registered before the webhook.
      // It consumes the body; express.raw on the route then finds nothing to
      // read and leaves request.body as the parsed object.
      app.use(express.json());
      app.post("/webhooks", express.raw({ type: "application/json" }), (request, response) => {
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const result = handleWebhook(ledger, raw, request.header("x-signature"));
        response.status(result.status).json(result.body);
      });
      return listenExpress(app);
    };

    const { report, ledger } = await deliverDuplicates(start);

    expect(report.passed).toBe(false);
    expect(statusesOf(report)).toEqual(Array(9).fill(401));
    expect(ledger.handled).toBe(0);
  });
});
