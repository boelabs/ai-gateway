CREATE INDEX CONCURRENTLY IF NOT EXISTS "gateway_operations_finished_ended_at_idx" ON "gateway_operations" ("ended_at") WHERE "lifecycle_state" = 'finished';
