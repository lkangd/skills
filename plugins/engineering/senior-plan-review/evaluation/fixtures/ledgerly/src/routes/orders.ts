import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db/pool.js";
import { reserveStock } from "../services/inventory.js";
import { requireAdmin } from "../middleware/auth.js";

export const ordersRouter = Router();

const createOrderSchema = z.object({
  customer_id: z.number().int().positive().optional(),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        quantity: z.number().int().positive().max(1000),
      }),
    )
    .min(1),
});

ordersRouter.get("/", async (req, res) => {
  // Returns every order visible to the caller. There is no pagination yet;
  // the web table (web/src/components/OrderTable.tsx) renders the full list.
  const isAdmin = req.user!.role === "admin";
  const { rows } = isAdmin
    ? await pool.query("SELECT * FROM orders ORDER BY created_at DESC")
    : await pool.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [req.user!.id]);
  res.json({ orders: rows });
});

ordersRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "not_found" });
  if (req.user!.role !== "admin" && order.user_id !== req.user!.id) {
    return res.status(404).json({ error: "not_found" });
  }
  const items = await pool.query("SELECT * FROM order_items WHERE order_id = $1", [id]);
  return res.json({ order, items: items.rows });
});

ordersRouter.post("/", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });

  const { items, customer_id } = parsed.data;

  const order = await withTransaction(async (client) => {
    let totalCents = 0;
    const priced: Array<{ product_id: number; quantity: number; unit_price_cents: number }> = [];

    for (const item of items) {
      const product = await reserveStock(client, item.product_id, item.quantity);
      totalCents += product.unit_price_cents * item.quantity;
      priced.push({ ...item, unit_price_cents: product.unit_price_cents });
    }

    const inserted = await client.query(
      "INSERT INTO orders (user_id, customer_id, total_cents) VALUES ($1, $2, $3) RETURNING *",
      [req.user!.id, customer_id ?? null, totalCents],
    );
    const order = inserted.rows[0];

    for (const p of priced) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
        [order.id, p.product_id, p.quantity, p.unit_price_cents],
      );
    }
    return order;
  });

  res.status(201).json({ order });
});

ordersRouter.post("/:id/cancel", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await pool.query(
    "UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('pending', 'overdue')",
    [id],
  );
  if (!rowCount) return res.status(409).json({ error: "not_cancellable" });
  return res.json({ ok: true });
});
