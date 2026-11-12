CREATE INDEX CONCURRENTLY IF NOT EXISTS "gateway_operations_virtual_key_started_idx" ON "gateway_operations" ("virtual_key_id", "started_at" DESC);
