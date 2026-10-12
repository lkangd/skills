-- Up Migration
-- Reporting queries filter payments by received_at; added after the Q2 incident
-- where the monthly reconciliation report timed out. (orders ~ 41M rows,
-- payments ~ 38M rows in production as of this migration.)
CREATE INDEX CONCURRENTLY payments_received_at_idx ON payments(received_at);

-- Down Migration
DROP INDEX CONCURRENTLY payments_received_at_idx;
