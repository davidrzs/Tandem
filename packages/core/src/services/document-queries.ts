import { ForbiddenError } from "../errors.js";
import { and, asc, desc, eq, gt, isNull, like, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { collections, documents, runAsActor, SYSTEM, user, type Database } from "@tandem/db";
import { scanTaskItems } from "@tandem/editor";
import type { DocumentMeta } from "./documents.js";
import {
  DocumentServiceBase,
  documentMetaColumns,
  notTemplate,
  rowsOf,
  searchPaths,
  templateDocumentIds,
} from "./document-tree-internals.js";

export interface SearchOptions {
  collectionId?: string;
  limit?: number;
  /** Restrict to documents carrying this tag (exact, case-sensitive). */
  tag?: string;
  /** Drop these documents — typically the one the caller is working from,
   * which tends to quote its own queries verbatim. */
  excludeIds?: string[];
  /** Drop documents carrying any of these tags (exact, case-sensitive). */
  excludeTags?: string[];
}

/** A tag with the number of active, readable documents carrying it. */
export interface TagCount {
  tag: string;
  count: number;
}

export type SearchMatchKind =
  | "tag"
  | "title_phrase"
  | "phrase"
  | "all_terms"
  | "partial_terms"
  | "fuzzy_title";

/** Search result diagnostics are deliberately lexical and deterministic: MCP
 * clients can see exactly which terms matched and decide whether to retry. */
export interface SearchHit extends DocumentMeta {
  rank: number;
  snippet: string;
  matchedTerms: string[];
  fuzzyTitleTerms: string[];
  totalTerms: number;
  matchKind: SearchMatchKind;
  collectionName: string;
  /** Collection + active ancestor titles + the result title. */
  path: string;
}

export interface RecentDocumentsOptions {
  collectionId?: string;
  /** Only return documents updated strictly after this instant. */
  updatedAfter?: Date;
  /** Keyset cursor: return documents older than this document. */
  before?: { updatedAt: Date; id: string };
  limit?: number;
}

/** An in-document task (`- [ ] @user …`) assigned to a user, for the start page. */
export interface TodoItem {
  documentId: string;
  documentTitle: string;
  collectionId: string;
  workspaceId: string;
  /** 0-based line in the document's markdown (a stable-enough anchor). */
  line: number;
  text: string;
  done: boolean;
}

/** Read-side document queries: recency, search, tags, backlinks, tasks. */
export class DocumentQueryService extends DocumentServiceBase {
  /** Recently changed active documents, ordered newest-first with a stable
   * `(updated_at, id)` keyset cursor. The query is RLS-scoped and metadata-only. */
  async recent(opts: RecentDocumentsOptions = {}): Promise<DocumentMeta[]> {
    return this.exec((db) => {
      const before = opts.before
        ? or(
            lt(documents.updatedAt, opts.before.updatedAt),
            and(
              eq(documents.updatedAt, opts.before.updatedAt),
              lt(documents.id, opts.before.id),
            ),
          )
        : undefined;
      return db
        .select(documentMetaColumns)
        .from(documents)
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            notTemplate,
            opts.collectionId ? eq(documents.collectionId, opts.collectionId) : undefined,
            opts.updatedAfter ? gt(documents.updatedAt, opts.updatedAfter) : undefined,
            before,
          ),
        )
        .orderBy(desc(documents.updatedAt), desc(documents.id))
        .limit(opts.limit ?? 20);
    });
  }

  /** Attach the "Collection / Ancestor / Title" breadcrumb to search rows. */
  private async withPaths<T extends { id: string; title: string; collectionName: string }>(
    db: Database,
    rows: T[],
  ): Promise<Array<T & { path: string }>> {
    const paths = await searchPaths(db, rows.map((row) => row.id));
    return rows.map((row) => ({
      ...row,
      path: [row.collectionName, ...(paths.get(row.id) ?? [row.title || "Untitled"])].join(" / "),
    }));
  }

  /** Native Postgres search over title/body FTS plus pg_trgm title fuzziness.
   * Retrieval is deliberately broad (any lexical term); phrase/all-term/title
   * matches are ranking boosts, not gates. Never returns body/binary columns. */
  async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchHit[]> {
    // Prefix-match every term: the index uses the un-stemmed 'simple' config,
    // so "Read" must still find "Reading the river" while someone types.
    const terms = [
      ...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
    ].slice(0, 8);
    const tag = opts.tag?.trim();
    const excludeIds = opts.excludeIds ?? [];
    const excludeTags = (opts.excludeTags ?? []).map((t) => t.trim()).filter(Boolean);
    // A tag on its own is a valid search (browse by label); text alone or both.
    if (terms.length === 0 && !tag) return [];
    return this.exec(async (db) => {
      const tagFilter = tag ? sql`${documents.tags} @> ARRAY[${tag}]::text[]` : undefined;
      // Exclusions keep documents that merely QUOTE the query (a backlog of
      // example searches, notes about a query) out of the way: lexical ranking
      // cannot tell those apart from the documents that answer it.
      const excludeTagFilter =
        excludeTags.length > 0
          ? sql`NOT (${documents.tags} && ARRAY[${sql.join(
              excludeTags.map((t) => sql`${t}`),
              sql`, `,
            )}]::text[])`
          : undefined;
      const base = and(
        isNull(documents.deletedAt),
        isNull(documents.archivedAt),
        notTemplate,
        opts.collectionId ? eq(documents.collectionId, opts.collectionId) : undefined,
        tagFilter,
        excludeIds.length > 0 ? notInArray(documents.id, excludeIds) : undefined,
        excludeTagFilter,
      );

      // Tag-only browse: no text ranking, newest first, no snippet.
      if (terms.length === 0) {
        const rows = await db
          .select({
            ...documentMetaColumns,
            rank: sql<number>`0`,
            snippet: sql<string>`''`,
            matchedTerms: sql<string[]>`ARRAY[]::text[]`,
            fuzzyTitleTerms: sql<string[]>`ARRAY[]::text[]`,
            totalTerms: sql<number>`0`,
            matchKind: sql<SearchMatchKind>`'tag'`,
            collectionName: collections.name,
          })
          .from(documents)
          .innerJoin(collections, eq(collections.id, documents.collectionId))
          .where(base)
          .orderBy(desc(documents.updatedAt))
          .limit(opts.limit ?? 20);
        return this.withPaths(db, rows);
      }

      const termQueries = terms.map((term) =>
        sql`to_tsquery('simple', ${`'${term}':*`})`,
      );
      const broadQuery = sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" | ")})`;
      const strictQuery = sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" & ")})`;
      const phraseQuery = sql`to_tsquery('simple', ${terms.map((t) => `'${t}':*`).join(" <-> ")})`;
      const titleVector = sql`to_tsvector('simple', coalesce(${documents.title}, ''))`;
      const matchedCount = sql<number>`(${sql.join(
        termQueries.map(
          (termQuery) => sql`CASE WHEN ${documents.searchVector} @@ ${termQuery} THEN 1 ELSE 0 END`,
        ),
        sql` + `,
      )})`;
      const matchedTerms = sql<string[]>`array_remove(ARRAY[${sql.join(
        termQueries.map(
          (termQuery, index) =>
            sql`CASE WHEN ${documents.searchVector} @@ ${termQuery} THEN ${terms[index]!} ELSE NULL END`,
        ),
        sql`, `,
      )}]::text[], NULL)`;
      // Short inputs generate weak/noisy trigrams; FTS prefix search already
      // handles them better. Word similarity compares each term to a title span.
      const fuzzyTerms = terms.filter((term) => term.length >= 4);
      const fuzzyConditions = fuzzyTerms.map(
        (term) => sql`${term} <% lower(${documents.title})`,
      );
      const fuzzyFilter =
        fuzzyConditions.length > 0
          ? sql`(${sql.join(fuzzyConditions, sql` OR `)})`
          : sql`false`;
      const fuzzyTitleTerms = sql<string[]>`array_remove(ARRAY[${sql.join(
        fuzzyTerms.map((term) => {
          const termQuery = termQueries[terms.indexOf(term)]!;
          return sql`CASE WHEN NOT (${documents.searchVector} @@ ${termQuery}) AND ${term} <% lower(${documents.title}) THEN ${term} ELSE NULL END`;
        }),
        sql`, `,
      )}]::text[], NULL)`;
      const bestTitleSimilarity =
        fuzzyTerms.length > 0
          ? sql<number>`greatest(${sql.join(
              [sql`0::real`, ...fuzzyTerms.map(
                (term) => sql`word_similarity(${term}, lower(${documents.title}))`,
              )],
              sql`, `,
            )})`
          : sql<number>`0::real`;
      const titlePhrase = sql`${titleVector} @@ ${phraseQuery}`;
      const phraseMatch = sql`${documents.searchVector} @@ ${phraseQuery}`;
      const strictMatch = sql`${documents.searchVector} @@ ${strictQuery}`;
      const normalizedRank = sql<number>`ts_rank_cd(${documents.searchVector}, ${broadQuery}, 32)`;
      const rank = sql<number>`(
        CASE WHEN ${titlePhrase} THEN 8.0 ELSE 0.0 END
        + CASE WHEN ${phraseMatch} THEN 4.0 ELSE 0.0 END
        + CASE WHEN ${strictMatch} THEN 2.0 ELSE 0.0 END
        + (2.0 * ${matchedCount}::double precision / ${terms.length})
        + ${normalizedRank}::double precision
        + (0.5 * ${bestTitleSimilarity}::double precision)
      )`;
      const matchKind = sql<SearchMatchKind>`CASE
        WHEN ${titlePhrase} THEN 'title_phrase'
        WHEN ${phraseMatch} THEN 'phrase'
        WHEN ${strictMatch} THEN 'all_terms'
        WHEN ${matchedCount} > 0 THEN 'partial_terms'
        ELSE 'fuzzy_title'
      END`;
      // Highlight delimiters are control chars (chr 2/3): impossible in the
      // text itself, so clients can mark fragments without parsing HTML.
      const snippet = sql<string>`ts_headline('simple', ${documents.contentMd}, ${broadQuery}, 'MaxFragments=2, MaxWords=16, MinWords=6, StartSel=' || chr(2) || ', StopSel=' || chr(3))`;
      const rows = await db
        .select({
          ...documentMetaColumns,
          rank,
          snippet,
          matchedTerms,
          fuzzyTitleTerms,
          totalTerms: sql<number>`${terms.length}::integer`,
          matchKind,
          collectionName: collections.name,
        })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .where(
          and(
            base,
            sql`(${documents.searchVector} @@ ${broadQuery} OR ${fuzzyFilter})`,
          ),
        )
        .orderBy(desc(rank), desc(documents.updatedAt), asc(documents.id))
        .limit(opts.limit ?? 20);
      return this.withPaths(db, rows);
    });
  }

  /** Every distinct tag across the documents this actor can read (RLS-scoped)
   * with how many active documents carry it, sorted by name — for tag
   * autocomplete and agent-side browsing. Excludes archived/deleted. */
  async listTags(): Promise<TagCount[]> {
    const result = await this.exec((db) =>
      db.execute(sql`
        SELECT t.tag, count(DISTINCT d.id)::int AS count
        FROM documents d, unnest(d.tags) AS t(tag)
        WHERE d.deleted_at IS NULL AND d.archived_at IS NULL
          AND d.id NOT IN ${templateDocumentIds}
        GROUP BY t.tag
      `),
    );
    return rowsOf<TagCount>(result).sort((a, b) =>
      a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()),
    );
  }

  /** Documents that reference this one (a `[title](/d/<id>)` link in their
   * markdown — what pageRef nodes serialize to). RLS-scoped: you only see
   * referencing documents you could open anyway. */
  async backlinks(id: string): Promise<DocumentMeta[]> {
    return this.exec((db) =>
      db
        .select(documentMetaColumns)
        .from(documents)
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            notTemplate,
            ne(documents.id, id),
            like(documents.contentMd, `%](/d/${id})%`),
          ),
        )
        .orderBy(desc(documents.updatedAt))
        .limit(50),
    );
  }

  /**
   * Tasks assigned to the current user across every document they can read
   * (RLS scopes the scan). A task is assigned via an `@mention` of the user's
   * email or its local part: `- [ ] @alice ship the thing`.
   */
  async listMyTodos(): Promise<TodoItem[]> {
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
    const userId = this.actor.userId;
    // Email lookup runs system-scoped: the auth user table isn't RLS-granted.
    const [me] = await runAsActor(this.db, SYSTEM, (db) =>
      db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
    );
    if (!me) return [];
    const email = me.email.toLowerCase();
    const handles = new Set([email, email.split("@")[0]!]);

    const rows = await this.exec((db) =>
      db
        .select({
          id: documents.id,
          title: documents.title,
          collectionId: documents.collectionId,
          workspaceId: documents.workspaceId,
          contentMd: documents.contentMd,
        })
        .from(documents)
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            notTemplate,
            or(
              // Indexed: handles extracted at save time.
              sql`${documents.taskAssignees} && ARRAY[${sql.join(
                [...handles].map((h) => sql`${h}`),
                sql`, `,
              )}]::text[]`,
              // Rows not re-saved since task_assignees was added: cheap
              // prefilter, exact matching in the parser below.
              and(
                isNull(documents.taskAssignees),
                sql`${documents.contentMd} LIKE '%- [%'`,
              ),
            ),
          ),
        ),
    );

    const todos: TodoItem[] = [];
    for (const row of rows) {
      for (const task of scanTaskItems(row.contentMd)) {
        if (!task.mentions.some((m) => handles.has(m))) continue;
        todos.push({
          documentId: row.id,
          documentTitle: row.title,
          collectionId: row.collectionId,
          workspaceId: row.workspaceId,
          line: task.line,
          text: task.text,
          done: task.done,
        });
      }
    }
    return todos;
  }
}
