import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";

export const customersRouter = Router();

const createCustomerSchema = z.object({
  full_name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
});

customersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM customers WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  return res.json({ customer: rows[0] });
});

customersRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const { full_name, email, phone } = parsed.data;
  const { rows } = await pool.query(
    "INSERT INTO customers (full_name, email, phone) VALUES ($1, $2, $3) RETURNING *",
    [full_name, email ?? null, phone ?? null],
  );
  return res.status(201).json({ customer: rows[0] });
});
