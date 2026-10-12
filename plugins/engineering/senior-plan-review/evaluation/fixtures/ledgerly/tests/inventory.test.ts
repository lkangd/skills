import { describe, it, expect, vi } from "vitest";
import { reserveStock, OutOfStockError } from "../src/services/inventory.js";

function fakeClient(stock: number) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT")) return { rows: [{ id: 1, stock, unit_price_cents: 500 }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}

describe("reserveStock", () => {
  it("decrements stock when enough is available", async () => {
    const client = fakeClient(5);
    const product = await reserveStock(client as never, 1, 2);
    expect(product.unit_price_cents).toBe(500);
    expect(client.queries[1].sql).toMatch(/UPDATE products SET stock = stock - \$1/);
  });

  it("throws OutOfStockError when stock is insufficient", async () => {
    const client = fakeClient(1);
    await expect(reserveStock(client as never, 1, 2)).rejects.toBeInstanceOf(OutOfStockError);
    expect(client.queries).toHaveLength(1);
  });
});
