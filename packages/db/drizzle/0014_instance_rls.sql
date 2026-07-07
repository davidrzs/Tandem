-- Lock down the instance-admin tables and add the server-admin RLS helper.
-- instance_settings and instance_invites are system-managed: app_user gets no
-- grant, so the non-privileged role cannot read or mutate them at all. Enabling
-- RLS with no permissive policy is belt-and-suspenders (deny even if a grant is
-- later added by mistake). The SYSTEM connection is the table owner and bypasses
-- RLS, which is exactly who touches these tables (service code + auth hooks).

-- Enforce the single-row invariant: id is the sentinel `true`, so a second row
-- (whether via the default or an explicit id=false) is rejected.
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_singleton" CHECK ("id" = true);--> statement-breakpoint

ALTER TABLE "instance_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "instance_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Whether the acting user is the server administrator. SECURITY DEFINER so the
-- lookup reads "user" with owner privileges (app_user has no grant on it),
-- mirroring the app_admin_workspaces() idiom. Reusable in future RLS policies
-- and as defense-in-depth behind the adminProcedure tRPC check.
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "user"
    WHERE id = current_setting('app.user_id', true) AND role = 'admin'
  )
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_admin() TO app_user;
