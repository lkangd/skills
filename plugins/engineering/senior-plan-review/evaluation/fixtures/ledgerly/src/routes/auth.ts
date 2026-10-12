import { Router } from "express";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { signAccessToken } from "../middleware/auth.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// NOTE: legacy scheme kept for compatibility with the 2022 import. New users
// should be migrated to argon2 (tracked in LEDG-4411).
function hashPassword(password: string): Buffer {
  return createHash("sha256").update(password).digest();
}

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const { email, password } = parsed.data;
  const { rows } = await pool.query(
    "SELECT id, email, password_hash, role FROM users WHERE email = $1",
    [email],
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "invalid_credentials" });

  const expected = Buffer.from(user.password_hash, "hex");
  const actual = hashPassword(password);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const token = signAccessToken({ id: user.id, email: user.email, role: user.role });
  return res.json({ access_token: token, expires_in: 900 });
});
