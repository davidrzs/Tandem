import { ForbiddenError, NotFoundError } from "../errors.js";
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { collections, documents, runAsActor, SYSTEM, tasks, typeFields, user, type Database } from "@tandem/db";
import type { LiveSectionQuery } from "@tandem/editor";
import type { DocumentMeta } from "./documents.js";
import {
  DocumentServiceBase,
  documentMetaColumns,
  notTemplate,
  previousSibling,
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

/** A task item of a readable page, from the `tasks` projection. */
export interface TaskRow {
  documentId: string;
  documentTitle: string;
  collectionId: string;
  workspaceId: string;
  blockId: string;
  text: string;
  done: boolean;
  handles: string[];
  position: number;
  createdBy: string | null;
  ai: boolean;
  createdAt: Date;
  closedAt: Date | null;
}

/** Which tasks: one page's, a page's and everything under it, or those of
 * the page before a page in its series (same parent and type). */
export type TaskScope = { documentId: string } | { subtreeOf: string } | { previousSiblingOf: string };

/** Where to look for changes: a page and everything under it, or a whole
 * collection. */
export type ChangeScope = { subtreeOf: string } | { collectionId: string };

export interface PageChange {
  id: string;
  title: string;
  updatedAt: Date;
}

export interface ChangesSince {
  pagesUpdated: PageChange[];
  tasksClosed: TaskRow[];
  tasksAdded: TaskRow[];
}

export interface PageLink {
  id: string;
  title: string;
}

/** A live section resolved against the page that holds it. `source` is the
 * previous page in the series; `scope` the page whose subtree "since last
 * meeting" covers (null: the whole collection). */
export type LiveSectionResult =
  | { query: "open_from_last_time"; source: PageLink | null; tasks: TaskRow[] }
  | {
      query: "since_last_meeting";
      source: PageLink | null;
      since: string | null;
      scope: PageLink | null;
      changes: ChangesSince;
    }
  | { query: "open_tasks_here"; tasks: TaskRow[] };

/** A page whose due or review date is past or within the horizon. */
export interface DueItem {
  documentId: string;
  title: string;
  fieldKey: string;
  fieldLabel: string;
  /** YYYY-MM-DD */
  date: string;
  overdue: boolean;
}

/** How far ahead Home looks for due and review dates. */
export const DUE_SOON_DAYS = 30;

const LIST_LIMIT = 50;

const taskColumns = {
  documentId: tasks.documentId,
  documentTitle: documents.title,
  collectionId: documents.collectionId,
  workspaceId: documents.workspaceId,
  blockId: tasks.blockId,
  text: tasks.text,
  done: tasks.done,
  handles: tasks.handles,
  position: tasks.position,
  createdBy: tasks.createdBy,
  ai: tasks.ai,
  createdAt: tasks.createdAt,
  closedAt: tasks.closedAt,
};

/** Ids of `rootId` and every page under it (RLS-scoped like the caller). */
const subtreeIds = (rootId: string) => sql`(
  WITH RECURSIVE sub(id) AS (
    SELECT ${rootId}::uuid
    UNION
    SELECT d.id FROM documents d JOIN sub ON d.parent_document_id = sub.id
  )
  SELECT id FROM sub
)`;

/** Task rows of live, non-template pages matching `where`. */
function taskRows(db: Database, where: SQL | undefined): Promise<TaskRow[]> {
  return db
    .select(taskColumns)
    .from(tasks)
    .innerJoin(documents, eq(documents.id, tasks.documentId))
    .where(and(isNull(documents.deletedAt), isNull(documents.archivedAt), notTemplate, where))
    .orderBy(desc(documents.updatedAt), asc(tasks.documentId), asc(tasks.position));
}

/** A date or date-time property value as the instant its day (or moment) starts. */
function startOf(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
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
   * (RLS scopes the rows). A task is assigned via an `@mention` of the user's
   * email or its local part: `- [ ] @alice ship the thing`.
   */
  async listMyTodos(): Promise<TaskRow[]> {
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
    const userId = this.actor.userId;
    // Email lookup runs system-scoped: the auth user table isn't RLS-granted.
    const [me] = await runAsActor(this.db, SYSTEM, (db) =>
      db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
    );
    if (!me) return [];
    const email = me.email.toLowerCase();
    const handles = [email, email.split("@")[0]!];
    return this.exec((db) =>
      taskRows(
        db,
        sql`${tasks.handles} && ARRAY[${sql.join(
          handles.map((h) => sql`${h}`),
          sql`, `,
        )}]::text[]`,
      ),
    );
  }

  /** Open tasks in `scope`, newest-edited page first, in page order. */
  async openTasks(scope: TaskScope): Promise<TaskRow[]> {
    return this.exec(async (db) => {
      if ("documentId" in scope) {
        return taskRows(db, and(eq(tasks.done, false), eq(tasks.documentId, scope.documentId)));
      }
      if ("subtreeOf" in scope) {
        return taskRows(db, and(eq(tasks.done, false), sql`${tasks.documentId} IN ${subtreeIds(scope.subtreeOf)}`));
      }
      const previous = await this.previousOf(db, scope.previousSiblingOf);
      return previous ? taskRows(db, and(eq(tasks.done, false), eq(tasks.documentId, previous.id))) : [];
    });
  }

  /** What happened in `scope` after `since`: pages edited, tasks closed and
   * tasks added, newest first, each capped. `excludeId` leaves out the page
   * asking (a meeting's own notes are not news to it). */
  async changesSince(scope: ChangeScope, since: Date, excludeId?: string): Promise<ChangesSince> {
    return this.exec((db) => this.changesIn(db, scope, since, excludeId));
  }

  private async changesIn(
    db: Database,
    scope: ChangeScope,
    since: Date,
    excludeId?: string,
  ): Promise<ChangesSince> {
    const inScope =
      "subtreeOf" in scope
        ? sql`${documents.id} IN ${subtreeIds(scope.subtreeOf)}`
        : eq(documents.collectionId, scope.collectionId);
    const others = excludeId ? ne(documents.id, excludeId) : undefined;
    const pagesUpdated = await db
      .select({ id: documents.id, title: documents.title, updatedAt: documents.updatedAt })
      .from(documents)
      .where(
        and(
          inScope,
          others,
          gt(documents.updatedAt, since),
          isNull(documents.deletedAt),
          isNull(documents.archivedAt),
          notTemplate,
        ),
      )
      .orderBy(desc(documents.updatedAt), asc(documents.id))
      .limit(LIST_LIMIT);
    const tasksClosed = await taskRows(db, and(inScope, others, eq(tasks.done, true), gt(tasks.closedAt, since)));
    const tasksAdded = await taskRows(db, and(inScope, others, gt(tasks.createdAt, since)));
    return {
      pagesUpdated,
      tasksClosed: tasksClosed.slice(0, LIST_LIMIT),
      tasksAdded: tasksAdded.slice(0, LIST_LIMIT),
    };
  }

  /** The page before `id` in its series, when `id` has a type. */
  private async previousOf(db: Database, id: string) {
    const [page] = await db
      .select({
        typeId: documents.typeId,
        collectionId: documents.collectionId,
        parentDocumentId: documents.parentDocumentId,
      })
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
    if (!page) throw new NotFoundError("document not found");
    if (!page.typeId) return null;
    return previousSibling(db, { ...page, typeId: page.typeId }, id);
  }

  /** Resolve a live section against the page `documentId` that holds it. */
  async liveSection(documentId: string, query: LiveSectionQuery): Promise<LiveSectionResult> {
    return this.exec(async (db) => {
      if (query === "open_tasks_here") {
        const under = sql`${tasks.documentId} IN ${subtreeIds(documentId)}`;
        return {
          query,
          tasks: await taskRows(db, and(eq(tasks.done, false), under, ne(tasks.documentId, documentId))),
        };
      }
      const previous = await this.previousOf(db, documentId);
      const source = previous ? { id: previous.id, title: previous.title } : null;
      if (query === "open_from_last_time") {
        return {
          query,
          source,
          tasks: previous ? await taskRows(db, and(eq(tasks.done, false), eq(tasks.documentId, previous.id))) : [],
        };
      }
      if (!previous) {
        return { query, source, since: null, scope: null, changes: { pagesUpdated: [], tasksClosed: [], tasksAdded: [] } };
      }
      const since = previous.date ? startOf(previous.date) : previous.createdAt;
      const scope = await this.seriesScope(db, documentId);
      return {
        query,
        source,
        since: since.toISOString(),
        scope: "subtreeOf" in scope ? scope.page : null,
        changes: await this.changesIn(
          db,
          "subtreeOf" in scope ? { subtreeOf: scope.page.id } : scope,
          since,
          documentId,
        ),
      };
    });
  }

  /** What a series page reports on: its nearest ancestor with a type (the
   * project above "Meetings"), else its parent, else its collection. */
  private async seriesScope(
    db: Database,
    documentId: string,
  ): Promise<{ subtreeOf: string; page: PageLink } | { collectionId: string }> {
    const ancestors = rowsOf<{ id: string; title: string; type_id: string | null; collection_id: string }>(
      await db.execute(sql`
        WITH RECURSIVE up(id, parent_id, title, type_id, collection_id, depth) AS (
          SELECT id, parent_document_id, title, type_id, collection_id, 0 FROM documents WHERE id = ${documentId}
          UNION ALL
          SELECT d.id, d.parent_document_id, d.title, d.type_id, d.collection_id, up.depth + 1
          FROM documents d JOIN up ON d.id = up.parent_id
        )
        SELECT id, title, type_id, collection_id FROM up WHERE depth > 0 ORDER BY depth
      `),
    );
    const page = ancestors.find((a) => a.type_id) ?? ancestors[0];
    if (page) return { subtreeOf: page.id, page: { id: page.id, title: page.title } };
    const [self] = await db
      .select({ collectionId: documents.collectionId })
      .from(documents)
      .where(eq(documents.id, documentId));
    return { collectionId: self!.collectionId };
  }

  /** Pages whose due or review date (a date field keyed like `due` or
   * `next_review`) is before `today` (overdue) or within DUE_SOON_DAYS of it,
   * soonest first. `today` is the reader's calendar day, YYYY-MM-DD. */
  async dueSoon(today: string): Promise<DueItem[]> {
    const horizon = new Date(Date.parse(`${today}T00:00:00.000Z`) + DUE_SOON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const date = sql<string>`left(${documents.properties} ->> ${typeFields.id}, 10)`;
    const rows = await this.exec((db) =>
      db
        .select({
          documentId: documents.id,
          title: documents.title,
          fieldKey: typeFields.key,
          fieldLabel: typeFields.label,
          date,
        })
        .from(documents)
        .innerJoin(typeFields, eq(typeFields.workspaceId, documents.workspaceId))
        .where(
          and(
            isNull(documents.deletedAt),
            isNull(documents.archivedAt),
            notTemplate,
            inArray(typeFields.kind, ["date", "datetime"]),
            isNull(typeFields.retiredAt),
            sql`${typeFields.key} ~* '(^|_)(due|review)'`,
            sql`${documents.properties} ? ${typeFields.id}`,
            sql`${date} <= ${horizon}`,
          ),
        )
        .orderBy(asc(date), asc(documents.title), asc(documents.id))
        .limit(LIST_LIMIT),
    );
    return rows.map((row) => ({ ...row, overdue: row.date < today }));
  }
}
