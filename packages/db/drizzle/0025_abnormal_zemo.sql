ALTER TABLE "documents" ADD COLUMN "task_assignees" text[];--> statement-breakpoint
CREATE INDEX "documents_task_assignees_idx" ON "documents" USING gin ("task_assignees");