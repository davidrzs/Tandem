-- Page ids a document points at: `[title](/d/<id>)` links in its markdown
-- (what page-reference chips serialize to) and every string value, or list
-- element, of its properties that looks like an id. Feeds the indexed
-- documents.link_targets column that backlinks look up instead of scanning
-- every document's body. IMMUTABLE so a generated column can use it.
CREATE OR REPLACE FUNCTION doc_link_targets(md text, props jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT t), '{}'::text[])
  FROM (
    SELECT m[1] AS t
    FROM regexp_matches(coalesce(md, ''), '\]\(/d/([0-9a-fA-F-]{36})\)', 'g') AS m
    UNION ALL
    -- lax mode: [*] also yields a plain (non-array) value itself.
    SELECT v #>> '{}'
    FROM jsonb_path_query(coalesce(props, '{}'::jsonb), 'lax $.*[*]') AS v
    WHERE jsonb_typeof(v) = 'string'
  ) s
  WHERE t ~ '^[0-9a-fA-F-]{36}$'
$$;
