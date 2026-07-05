import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { DocumentWriteDeniedError } from "@tandem/core";
import { stateToJSON } from "@tandem/editor";
import type { Services } from "./services.js";
import type { CollabWriter } from "./collab-writer.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Context {
  services: Services;
  user: AuthUser | null;
  /** Writes through the live doc as the human (restore). Absent without Hocuspocus. */
  collabWriter?: CollabWriter;
  /** Push a "something about this document changed" ping to its live
   * collaboration channel (no data — clients refetch through their own,
   * RLS-scoped queries). Absent in tests that run without Hocuspocus. */
  notifyDocument?: (documentId: string, topic: "comments" | "snapshots") => void;
}

const isProd = process.env.NODE_ENV === "production";

const t = initTRPC.context<Context>().create({
  // Don't leak internal error details (stack/DB messages) in production.
  errorFormatter({ shape, error }) {
    if (isProd && error.code === "INTERNAL_SERVER_ERROR") {
      return { ...shape, message: "Internal server error", data: { ...shape.data, stack: undefined } };
    }
    return shape;
  },
});

/** Turn a DB unique-constraint violation into a clean CONFLICT; pass through the rest. */
function mapError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "23505" || /unique|duplicate key/i.test(message)) {
    return new TRPCError({ code: "CONFLICT", message: "That name or slug is already taken." });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message, cause: err });
}

/** Requires a signed-in user; narrows ctx.user to non-null and maps DB errors. */
const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  try {
    return await next({ ctx: { ...ctx, user: ctx.user } });
  } catch (err) {
    throw mapError(err);
  }
});

const uuid = z.string().uuid();

export const appRouter = t.router({
  workspaces: t.router({
    mine: protectedProcedure.query(({ ctx }) => ctx.services.workspaces.listMine()),
    members: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.workspaces.members(input.workspaceId)),
    create: protectedProcedure
      .input(z.object({ name: z.string().min(1), slug: z.string().min(1) }))
      .mutation(({ ctx, input }) => ctx.services.workspaces.create(input)),
    createInvite: protectedProcedure
      .input(
        z.object({
          workspaceId: uuid,
          role: z.enum(["member", "admin"]).optional(),
          email: z.string().email().optional(),
          expiresInDays: z.number().int().positive().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.workspaces.createInvite(input)),
    acceptInvite: protectedProcedure
      .input(z.object({ token: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.services.workspaces.acceptInvite(input.token, ctx.user.id),
      ),
  }),

  groups: t.router({
    list: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.groups.list(input.workspaceId)),
    create: protectedProcedure
      .input(z.object({ workspaceId: uuid, name: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.services.groups.create(input.workspaceId, input.name),
      ),
    addMember: protectedProcedure
      .input(z.object({ groupId: uuid, userId: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.services.groups.addMember(input.groupId, input.userId),
      ),
    removeMember: protectedProcedure
      .input(z.object({ groupId: uuid, userId: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.services.groups.removeMember(input.groupId, input.userId),
      ),
    members: protectedProcedure
      .input(z.object({ groupId: uuid }))
      .query(({ ctx, input }) => ctx.services.groups.members(input.groupId)),
    delete: protectedProcedure
      .input(z.object({ groupId: uuid }))
      .mutation(({ ctx, input }) => ctx.services.groups.delete(input.groupId)),
  }),

  collections: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.services.collections.list()),
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          slug: z.string().min(1),
          description: z.string().optional(),
          workspaceId: uuid.optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.collections.create(input)),
    update: protectedProcedure
      .input(
        z.object({
          id: uuid,
          name: z.string().min(1).optional(),
          description: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const { id, ...patch } = input;
        return ctx.services.collections.update(id, patch);
      }),
    delete: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(({ ctx, input }) => ctx.services.collections.softDelete(input.id)),
    setDefaultRole: protectedProcedure
      .input(z.object({ id: uuid, role: z.enum(["none", "read", "read_write"]) }))
      .mutation(({ ctx, input }) =>
        ctx.services.collections.setDefaultRole(input.id, input.role),
      ),
    grant: protectedProcedure
      .input(
        z.object({
          id: uuid,
          principalType: z.enum(["user", "group"]),
          principalId: z.string().min(1),
          role: z.enum(["read", "read_write"]),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.services.collections.grant(
          input.id,
          input.principalType,
          input.principalId,
          input.role,
        ),
      ),
    revoke: protectedProcedure
      .input(
        z.object({
          id: uuid,
          principalType: z.enum(["user", "group"]),
          principalId: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.services.collections.revoke(input.id, input.principalType, input.principalId),
      ),
    permissions: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.collections.listPermissions(input.id)),
  }),

  documents: t.router({
    tree: protectedProcedure
      .input(z.object({ collectionId: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.tree(input.collectionId)),

    // Metadata only (no body/binary) — what the editor header needs. The body
    // itself always arrives over the Yjs collab channel.
    getMeta: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.getMeta(input.id)),

    create: protectedProcedure
      .input(
        z.object({
          collectionId: uuid,
          title: z.string().optional(),
          markdown: z.string().optional(),
          parentDocumentId: uuid.optional(),
          tags: z.array(z.string()).optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.documents.create(input)),

    update: protectedProcedure
      .input(
        z.object({
          id: uuid,
          title: z.string().optional(),
          tags: z.array(z.string()).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...patch } = input;
        const doc = await ctx.services.documents.update(id, patch);
        // A null row on an RLS-scoped write means denied, not "not found".
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot edit this document." });
        return doc;
      }),

    move: protectedProcedure
      .input(
        z.object({
          id: uuid,
          parentDocumentId: uuid.nullable(),
          position: z.number().optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const { id, ...target } = input;
        return ctx.services.documents.move(id, target);
      }),

    archive: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const doc = await ctx.services.documents.archive(input.id);
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot archive this document." });
        return doc;
      }),

    restore: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const doc = await ctx.services.documents.restore(input.id);
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot restore this document." });
        return doc;
      }),

    delete: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const deleted = await ctx.services.documents.softDelete(input.id);
        if (!deleted) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot delete this document." });
      }),

    listArchived: protectedProcedure
      .input(z.object({ collectionId: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.listArchived(input.collectionId)),

    myTodos: protectedProcedure.query(({ ctx }) => ctx.services.documents.listMyTodos()),

    listTags: protectedProcedure.query(({ ctx }) => ctx.services.documents.listTags()),

    listSnapshots: protectedProcedure
      .input(z.object({ documentId: uuid }))
      .query(({ ctx, input }) => ctx.services.snapshots.list(input.documentId)),

    getSnapshot: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ ctx, input }) => {
        const snap = await ctx.services.snapshots.get(input.id);
        if (!snap) throw new TRPCError({ code: "NOT_FOUND", message: "That version is unavailable." });
        // Ship ProseMirror JSON, never the raw Yjs bytes.
        return { createdAt: snap.createdAt, kind: snap.kind, contentJson: stateToJSON(snap.ydocState) };
      }),

    restoreSnapshot: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        if (!ctx.collabWriter) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Restore isn't available here." });
        }
        // RLS-scoped: a visible snapshot implies a readable doc; the writer
        // additionally enforces WRITE access before touching the live doc.
        const snap = await ctx.services.snapshots.get(input.id);
        if (!snap) throw new TRPCError({ code: "NOT_FOUND", message: "That version is unavailable." });
        try {
          const result = await ctx.collabWriter.restoreTo(snap.documentId, snap);
          if (result.changed) ctx.notifyDocument?.(snap.documentId, "snapshots");
          return result;
        } catch (err) {
          if (err instanceof DocumentWriteDeniedError) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You can't restore this document." });
          }
          throw err;
        }
      }),

    backlinks: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.backlinks(input.id)),

    search: protectedProcedure
      .input(
        z.object({
          query: z.string(),
          collectionId: uuid.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          tag: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => {
        const { query, ...opts } = input;
        return ctx.services.documents.search(query, opts);
      }),
  }),

  settings: t.router({
    get: protectedProcedure.query(async ({ ctx }) => ({
      mcpEnabled: await ctx.services.settings.mcpEnabled(),
    })),
    setMcpEnabled: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.services.settings.setMcpEnabled(input.enabled)),
    audit: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.settings.auditTrail(input.workspaceId)),
  }),

  comments: t.router({
    list: protectedProcedure
      .input(z.object({ documentId: uuid }))
      .query(({ ctx, input }) => ctx.services.comments.list(input.documentId)),
    create: protectedProcedure
      .input(
        z.object({
          documentId: uuid,
          body: z.string().min(1).max(10_000),
          anchor: z.string().max(4096).optional(),
          head: z.string().max(4096).optional(),
          parentId: uuid.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const comment = await ctx.services.comments.create(input);
        ctx.notifyDocument?.(input.documentId, "comments");
        return comment;
      }),
    setResolved: protectedProcedure
      .input(z.object({ id: uuid, resolved: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const comment = await ctx.services.comments.setResolved(input.id, input.resolved);
        ctx.notifyDocument?.(comment.documentId, "comments");
        return comment;
      }),
    delete: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const deleted = await ctx.services.comments.remove(input.id);
        if (!deleted) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the author can delete a comment." });
        }
        ctx.notifyDocument?.(deleted.documentId, "comments");
      }),
  }),
});

export type AppRouter = typeof appRouter;
