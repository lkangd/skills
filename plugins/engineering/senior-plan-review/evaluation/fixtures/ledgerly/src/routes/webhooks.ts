import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";
import { recordPayment } from "../services/payments.js";

export const webhooksRouter = Router();

function verifySignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", env.PAYMENT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Payment provider webhook. The provider retries delivery with exponential
 * backoff for up to 72h until it receives a 2xx, so the same event can arrive
 * more than once (see docs/ops-runbook.txt "duplicate payment" entry).
 */
webhooksRouter.post("/payments", async (req, res) => {
  const raw = JSON.stringify(req.body);
  if (!verifySignature(raw, req.header("x-ledgerly-signature"))) {
    return res.status(401).json({ error: "bad_signature" });
  }

  const event = req.body as { id: string; type: string; data: { order_id: number; amount_cents: number } };
  if (event.type !== "payment.succeeded") return res.status(204).end();

  await recordPayment(event.id, event.data.order_id, event.data.amount_cents);
  return res.status(200).json({ received: true });
});
