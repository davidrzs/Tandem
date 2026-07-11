ALTER TABLE "audit_log" ADD COLUMN "ai" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: until now every workspace-scoped entry was an MCP agent action
-- (instance-scoped entries, workspace_id IS NULL, were human admin actions).
UPDATE "audit_log" SET "ai" = true WHERE "workspace_id" IS NOT NULL;
