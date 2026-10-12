-- Up Migration
CREATE TABLE customers (
  id          BIGSERIAL PRIMARY KEY,
  full_name   TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN customer_id BIGINT REFERENCES customers(id);
CREATE INDEX orders_customer_id_idx ON orders(customer_id);

-- Down Migration
ALTER TABLE orders DROP COLUMN customer_id;
DROP TABLE customers;
