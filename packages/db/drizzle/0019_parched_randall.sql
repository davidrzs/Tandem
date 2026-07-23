ALTER TABLE "collections" ADD COLUMN "position" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Seed distinct positions in the current display order (alphabetical per
-- workspace) so midpoint-average reordering works from the first drag.
UPDATE "collections" c
SET "position" = ranked.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY name, id) AS rn
  FROM "collections"
) ranked
WHERE c.id = ranked.id;
