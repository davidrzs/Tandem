CREATE TABLE "instance_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"token" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"registration_mode" text DEFAULT 'open' NOT NULL,
	"allowed_email_domains" text[] DEFAULT '{}' NOT NULL,
	"instance_name" text DEFAULT 'Tandem' NOT NULL,
	"allow_workspace_creation" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_expires" timestamp;