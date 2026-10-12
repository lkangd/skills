import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: vi.fn() })),
}));

import request from "supertest";
import { createApp } from "../src/server.js";
import { signAccessToken } from "../src/middleware/auth.js";
import { pool } from "../src/db/pool.js";

const memberToken = signAccessToken({ id: 7, email: "m@example.com", role: "member" });
const adminToken = signAccessToken({ id: 1, email: "a@example.com", role: "admin" });

describe("GET /orders", () => {
  beforeEach(() => vi.mocked(pool.query).mockReset());

  it("scopes to the caller for members", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const res = await request(createApp()).get("/orders").set("authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(pool.query).mock.calls[0][0]).toMatch(/WHERE user_id = \$1/);
  });

  it("returns everything for admins", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const res = await request(createApp()).get("/orders").set("authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(pool.query).mock.calls[0][0]).not.toMatch(/WHERE/);
  });

  it("rejects missing tokens", async () => {
    const res = await request(createApp()).get("/orders");
    expect(res.status).toBe(401);
  });
});

describe("POST /orders/:id/cancel", () => {
  it("requires admin", async () => {
    const res = await request(createApp()).post("/orders/5/cancel").set("authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });
});
