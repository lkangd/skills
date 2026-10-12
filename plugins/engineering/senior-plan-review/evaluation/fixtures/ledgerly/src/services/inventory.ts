import type { PoolClient } from "pg";

export class OutOfStockError extends Error {
  constructor(public readonly productId: number, public readonly requested: number, public readonly available: number) {
    super(`product ${productId}: requested ${requested}, available ${available}`);
    this.name = "OutOfStockError";
  }
}

export interface ReservedProduct {
  id: number;
  unit_price_cents: number;
}

/**
 * Decrement stock for a product inside the caller's transaction.
 *
 * Known issue (LEDG-5120): two concurrent orders for the last unit can both
 * pass the availability check before either UPDATE commits, which lets stock
 * go negative until the CHECK constraint rejects the second UPDATE with a
 * generic 500 instead of an OutOfStockError. Reproduced in staging during the
 * flash sale on 2026-03-02.
 */
export async function reserveStock(client: PoolClient, productId: number, quantity: number): Promise<ReservedProduct> {
  const { rows } = await client.query("SELECT id, stock, unit_price_cents FROM products WHERE id = $1", [productId]);
  const product = rows[0];
  if (!product) throw new Error(`product ${productId} not found`);
  if (product.stock < quantity) throw new OutOfStockError(productId, quantity, product.stock);

  await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [quantity, productId]);
  return { id: product.id, unit_price_cents: product.unit_price_cents };
}

export async function releaseStock(client: PoolClient, productId: number, quantity: number): Promise<void> {
  await client.query("UPDATE products SET stock = stock + $1 WHERE id = $2", [quantity, productId]);
}
