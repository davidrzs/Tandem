ALTER TABLE "documents" DROP COLUMN "published_at";--> statement-breakpoint
-- Documents of a soft-deleted collection must vanish from every RLS-scoped
-- query (search, tree, todos). Both helper functions re-query `collections`,
-- so they can honour deleted_at directly.
CREATE OR REPLACE FUNCTION app_readable_collections() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT c.id FROM collections c
  WHERE c.workspace_id IN (SELECT app_current_workspaces())
    AND c.deleted_at IS NULL
    AND (
      EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = current_setting('app.user_id', true) AND m.role IN ('owner','admin'))
      OR c.default_role IN ('read','read_write')
      OR EXISTS (SELECT 1 FROM collection_permissions p WHERE p.collection_id = c.id AND p.role IN ('read','read_write') AND (
            (p.principal_type = 'user' AND p.principal_id = current_setting('app.user_id', true))
         OR (p.principal_type = 'group' AND p.principal_id IN (SELECT group_id::text FROM group_members WHERE user_id = current_setting('app.user_id', true)))
      ))
    )
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_writable_collections() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT c.id FROM collections c
  WHERE c.workspace_id IN (SELECT app_current_workspaces())
    AND c.deleted_at IS NULL
    AND (
      EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = current_setting('app.user_id', true) AND m.role IN ('owner','admin'))
      OR c.default_role = 'read_write'
      OR EXISTS (SELECT 1 FROM collection_permissions p WHERE p.collection_id = c.id AND p.role = 'read_write' AND (
            (p.principal_type = 'user' AND p.principal_id = current_setting('app.user_id', true))
         OR (p.principal_type = 'group' AND p.principal_id IN (SELECT group_id::text FROM group_members WHERE user_id = current_setting('app.user_id', true)))
      ))
    )
$$;
