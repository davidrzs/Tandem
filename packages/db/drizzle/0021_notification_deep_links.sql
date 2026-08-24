ALTER TABLE "notifications" ADD COLUMN "target_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
