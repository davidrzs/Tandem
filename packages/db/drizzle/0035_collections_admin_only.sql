-- Anyone who can write a collection may rename, describe and reorder it and
-- set its default template. Sharing (default_role), deletion and moving it to
-- another workspace are owner/admin actions: the service checks the role and
-- then writes as the system. The database enforced none of that, so a writer
-- going through RLS could share, soft-delete or hard-delete a collection.
-- Column grants close the update side (a policy cannot compare old and new
-- values); deletion becomes admin-only.
REVOKE UPDATE ON "collections" FROM app_user;--> statement-breakpoint
GRANT UPDATE ("name", "slug", "description", "icon", "color", "position", "default_template_id", "updated_at") ON "collections" TO app_user;--> statement-breakpoint
DROP POLICY "collections_delete" ON "collections";--> statement-breakpoint
CREATE POLICY "collections_delete" ON "collections" FOR DELETE USING ("workspace_id" IN (SELECT app_admin_workspaces()));
