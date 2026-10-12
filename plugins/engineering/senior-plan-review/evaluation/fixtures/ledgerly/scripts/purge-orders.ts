/**
 * One-off maintenance script: delete orders (and cascaded order_items) older
 * than N days regardless of status.
 *
 *   npm run purge -- --days 730            # dry run: prints counts only
 *   npm run purge -- --days 730 --yes      # actually deletes
 *   npm run purge -- --all --yes           # deletes EVERY order (test envs only)
 *
 * Uses DATABASE_URL from the environment. There is no environment guard: if
 * DATABASE_URL points at production, this deletes production data.
 */
import { pool } from "../src/db/pool.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const all = flag("--all");
  const days = Number(value("--days") ?? NaN);
  const confirmed = flag("--yes");

  if (!all && !Number.isFinite(days)) {
    console.error("usage: purge-orders --days <n> [--yes] | --all --yes");
    process.exit(2);
  }

  const where = all ? "TRUE" : "created_at < now() - ($1 || ' days')::interval";
  const params = all ? [] : [days];

  const count = await pool.query(`SELECT count(*)::int AS n FROM orders WHERE ${where}`, params);
  console.log(`matching orders: ${count.rows[0].n}`);

  if (!confirmed) {
    console.log("dry run; pass --yes to delete");
    return;
  }

  // payments reference orders without ON DELETE CASCADE, so delete them first.
  await pool.query(`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE ${where})`, params);
  const deleted = await pool.query(`DELETE FROM orders WHERE ${where}`, params);
  console.log(`deleted ${deleted.rowCount} orders`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
