-- A template's type and defaults are workspace definitions: only an owner or
-- admin sets them, as document_types and type_fields already enforce through
-- RLS. Policies can't compare the old row, so a trigger guards the columns
-- for app_user; system code (the table owner) passes.
CREATE OR REPLACE FUNCTION app_guard_template_definition() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user = 'app_user'
    AND (CASE TG_OP
      WHEN 'INSERT' THEN NEW.default_type_id IS NOT NULL OR NEW.defaults <> '{}'::jsonb
      ELSE NEW.default_type_id IS DISTINCT FROM OLD.default_type_id OR NEW.defaults IS DISTINCT FROM OLD.defaults
    END)
    AND NEW.workspace_id NOT IN (SELECT app_admin_workspaces())
  THEN
    RAISE EXCEPTION 'only a workspace owner or admin can set a template''s type or defaults';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER templates_guard_definition BEFORE INSERT OR UPDATE ON "templates"
  FOR EACH ROW EXECUTE FUNCTION app_guard_template_definition();
