import { pool } from "../db/pool.js";

/**
 * Record a successful payment and mark the order paid.
 *
 * Both statements run on the shared pool as independent auto-commit queries.
 * If the second one fails the payment row exists but the order stays
 * 'pending'; finance reconciles these by hand (docs/ops-runbook.txt).
 */
export async function recordPayment(providerEventId: string, orderId: number, amountCents: number): Promise<void> {
  await pool.query(
    "INSERT INTO payments (order_id, provider_event_id, amount_cents) VALUES ($1, $2, $3)",
    [orderId, providerEventId, amountCents],
  );
  await pool.query("UPDATE orders SET status = 'paid', updated_at = now() WHERE id = $1", [orderId]);
}
