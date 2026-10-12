import { StatusBadge, type OrderStatus } from "./StatusBadge";

export interface OrderRow {
  id: number;
  status: OrderStatus;
  total_cents: number;
  created_at: string;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function OrderTable({ orders }: { orders: OrderRow[] }) {
  return (
    <table className="order-table">
      <thead>
        <tr>
          <th>Order</th>
          <th>Status</th>
          <th>Total</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>#{o.id}</td>
            <td>
              <StatusBadge status={o.status} />
            </td>
            <td>{formatMoney(o.total_cents)}</td>
            <td>{new Date(o.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
