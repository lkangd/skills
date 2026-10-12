import type { CSSProperties } from "react";

export type OrderStatus = "pending" | "paid" | "shipped" | "cancelled" | "overdue";

const COLORS: Record<OrderStatus, { bg: string; fg: string }> = {
  pending: { bg: "#f3f4f6", fg: "#374151" },
  paid: { bg: "#dcfce7", fg: "#166534" },
  shipped: { bg: "#dbeafe", fg: "#1e40af" },
  cancelled: { bg: "#e5e7eb", fg: "#6b7280" },
  overdue: { bg: "#fef9c3", fg: "#854d0e" },
};

const LABELS: Record<OrderStatus, string> = {
  pending: "Pending",
  paid: "Paid",
  shipped: "Shipped",
  cancelled: "Cancelled",
  overdue: "Overdue",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { bg, fg } = COLORS[status];
  const style: CSSProperties = {
    background: bg,
    color: fg,
    borderRadius: 9999,
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 600,
  };
  return <span style={style}>{LABELS[status]}</span>;
}
