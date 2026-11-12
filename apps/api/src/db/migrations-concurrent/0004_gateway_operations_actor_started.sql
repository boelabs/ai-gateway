CREATE INDEX CONCURRENTLY IF NOT EXISTS "gateway_operations_actor_started_idx" ON "gateway_operations" ("actor", "started_at" DESC);
