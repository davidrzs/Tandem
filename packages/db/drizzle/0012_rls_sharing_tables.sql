-- Row-level security for the four remaining app tables. Until now groups,
-- group_members, collection_permissions and workspace_invites had no RLS and no
-- app_user grants, so they were reachable ONLY through system-scoped service
-- code that hand-checked owner/admin membership. Enabling RLS makes the database
-- the enforcing authority: a forgotten service-layer check can no longer read or
-- mutate another workspace's groups/sharing/invites. The app-layer role checks
-- stay in place as defense-in-depth and for clear error messages.

-- Workspaces where the acting user is an owner or admin (the "manage" scope).
CREATE OR REPLACE FUNCTION app_admin_workspaces() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT workspace_id FROM workspace_members
  WHERE user_id = current_setting('app.user_id', true) AND role IN ('owner','admin')
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_admin_workspaces() TO app_user;--> statement-breakpoint

-- Group ids the user can see (any group in a workspace they belong to) and the
-- subset they can manage (owner/admin). SECURITY DEFINER so the group lookup is
-- not itself subject to the group_members policies defined below.
CREATE OR REPLACE FUNCTION app_member_group_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id FROM groups WHERE workspace_id IN (SELECT app_current_workspaces())
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_member_group_ids() TO app_user;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_admin_group_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id FROM groups WHERE workspace_id IN (SELECT app_admin_workspaces())
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_admin_group_ids() TO app_user;--> statement-breakpoint

-- Collections whose workspace the user owns/admins (the sharing-manage scope).
CREATE OR REPLACE FUNCTION app_admin_collection_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id FROM collections WHERE workspace_id IN (SELECT app_admin_workspaces())
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_admin_collection_ids() TO app_user;--> statement-breakpoint

-- groups: any workspace member may read; only owner/admin may create or delete.
GRANT SELECT, INSERT, DELETE ON "groups" TO app_user;--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "groups_select" ON "groups" FOR SELECT USING ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "groups_insert" ON "groups" FOR INSERT WITH CHECK ("workspace_id" IN (SELECT app_admin_workspaces()));--> statement-breakpoint
CREATE POLICY "groups_delete" ON "groups" FOR DELETE USING ("workspace_id" IN (SELECT app_admin_workspaces()));--> statement-breakpoint

-- group_members: visible to members of the group's workspace; only owner/admin
-- may add or remove members.
GRANT SELECT, INSERT, DELETE ON "group_members" TO app_user;--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "group_members_select" ON "group_members" FOR SELECT USING ("group_id" IN (SELECT app_member_group_ids()));--> statement-breakpoint
CREATE POLICY "group_members_insert" ON "group_members" FOR INSERT WITH CHECK ("group_id" IN (SELECT app_admin_group_ids()));--> statement-breakpoint
CREATE POLICY "group_members_delete" ON "group_members" FOR DELETE USING ("group_id" IN (SELECT app_admin_group_ids()));--> statement-breakpoint

-- collection_permissions: only an owner/admin of the collection's workspace may
-- see or change its sharing grants. (The SECURITY DEFINER app_readable/
-- app_writable_collections functions read this table with owner privileges, so
-- enabling RLS here does not affect document/collection visibility checks.)
GRANT SELECT, INSERT, UPDATE, DELETE ON "collection_permissions" TO app_user;--> statement-breakpoint
ALTER TABLE "collection_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "collection_permissions_select" ON "collection_permissions" FOR SELECT USING ("collection_id" IN (SELECT app_admin_collection_ids()));--> statement-breakpoint
CREATE POLICY "collection_permissions_insert" ON "collection_permissions" FOR INSERT WITH CHECK ("collection_id" IN (SELECT app_admin_collection_ids()));--> statement-breakpoint
CREATE POLICY "collection_permissions_update" ON "collection_permissions" FOR UPDATE USING ("collection_id" IN (SELECT app_admin_collection_ids())) WITH CHECK ("collection_id" IN (SELECT app_admin_collection_ids()));--> statement-breakpoint
CREATE POLICY "collection_permissions_delete" ON "collection_permissions" FOR DELETE USING ("collection_id" IN (SELECT app_admin_collection_ids()));--> statement-breakpoint

-- workspace_invites: only an owner/admin may create an invite (creator pinned to
-- self); an invite is visible to its creator or the workspace's owners/admins.
-- Redeeming an invite is a capability (the invitee is not yet a member, so no
-- membership policy could authorize it) — that path is app_accept_invite() below.
GRANT SELECT, INSERT ON "workspace_invites" TO app_user;--> statement-breakpoint
ALTER TABLE "workspace_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_invites_select" ON "workspace_invites" FOR SELECT USING (
  "created_by" = current_setting('app.user_id', true) OR "workspace_id" IN (SELECT app_admin_workspaces())
);--> statement-breakpoint
CREATE POLICY "workspace_invites_insert" ON "workspace_invites" FOR INSERT WITH CHECK (
  "created_by" = current_setting('app.user_id', true) AND "workspace_id" IN (SELECT app_admin_workspaces())
);--> statement-breakpoint

-- Redeem an invite by its secret token: join the acting user to the invite's
-- workspace at the invite's role, single-use, honouring expiry. SECURITY DEFINER
-- because the invitee cannot be authorized by membership yet — the unguessable
-- token is the authorization. Acts only for current_setting('app.user_id'), so a
-- user can only ever accept an invite as themselves.
CREATE OR REPLACE FUNCTION app_accept_invite(p_token text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid text := current_setting('app.user_id', true);
  v_invite workspace_invites%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION 'no acting user';
  END IF;
  SELECT * INTO v_invite FROM workspace_invites
    WHERE token = p_token AND accepted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid or already-used invite';
  END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'invite expired';
  END IF;
  INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (v_invite.workspace_id, v_uid, v_invite.role)
    ON CONFLICT DO NOTHING;
  UPDATE workspace_invites SET accepted_at = now() WHERE id = v_invite.id;
  RETURN v_invite.workspace_id;
END;
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_accept_invite(text) TO app_user;
