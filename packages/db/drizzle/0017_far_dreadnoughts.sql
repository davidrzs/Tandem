CREATE TABLE "document_favorites" (
	"user_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_favorites_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "document_favorites" ADD CONSTRAINT "document_favorites_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;