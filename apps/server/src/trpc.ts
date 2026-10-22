import { initTRPC, TRPCError, type inferRouterOutputs } from "@trpc/server";
import { z } from "zod";
import {
  descriptionSchema,
  documentIdsSchema,
  documentCreateShape,
  documentMoveShape,
  documentSearchShape,
  documentUpdateShape,
  DocumentWriteDeniedError,
  fieldKeySchema,
  ForbiddenError,
  InvalidInputError,
  isListKind,
  nameSchema,
  NotFoundError,
  positionSchema,
  propertyPatchShape,
  tagsSchema,
  templateVariablesSchema,
  titleSchema,
} from "@tandem/core";
import { FIELD_KINDS } from "@tandem/db";
import { stateToJSON, type PropertyOp } from "@tandem/editor";
import type { Services } from "./services.js";
import type { CollabWriter } from "./collab-writer.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** Server-level role from the admin() plugin ('admin' unlocks /admin). */
  role?: string | null;
}

export interface Context {
  services: Services;
  user: AuthUser | null;
  /** Writes through the live doc as the human (restore). Absent without Hocuspocus. */
  collabWriter?: CollabWriter;
  /** Push a "something about this document changed" ping to its live
   * collaboration channel (no data — clients refetch through their own,
   * RLS-scoped queries). Absent in tests that run without Hocuspocus. */
  notifyDocument?: (documentId: string, topic: "comments" | "snapshots" | "meta") => void;
  /** Remaining single-use 2FA backup codes for a user, or null when not
   * enrolled. Server-side Better Auth call — wired in http.ts. */
  countBackupCodes?: (userId: string) => Promise<number | null>;
  /** Outbound email, present only when the instance has SMTP configured. */
  mailer?: { send(msg: { to: string; subject: string; text: string }): Promise<void> } | null;
  /** Public base URL, for links inside emails. */
  appUrl?: string;
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

/** Map domain errors and DB unique-constraint violations to transport codes;
 * anything unrecognized stays a 500. */
function mapError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof NotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: err.message, cause: err });
  }
  if (err instanceof ForbiddenError) {
    return new TRPCError({ code: "FORBIDDEN", message: err.message, cause: err });
  }
  if (err instanceof InvalidInputError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "23505" || /unique|duplicate key/i.test(message)) {
    return new TRPCError({ code: "CONFLICT", message: "That name or slug is already taken." });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message, cause: err });
}

async function writeProperties(ctx: Context, id: string, ops: PropertyOp[]): Promise<void> {
  try {
    if (ctx.collabWriter) await ctx.collabWriter.setProperties(id, ops);
    else await ctx.services.documents.editProperties(id, ops);
  } catch (err) {
    if (err instanceof DocumentWriteDeniedError) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You cannot edit this document." });
    }
    throw err;
  }
}

/** Requires a signed-in user; narrows ctx.user to non-null and maps DB errors. */
const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  // next() doesn't throw: a failed resolver comes back as { ok: false }. A
  // non-tRPC error arrives wrapped as an INTERNAL_SERVER_ERROR with the
  // original as its cause; map that. Deliberate TRPCErrors pass unchanged.
  const result = await next({ ctx: { ...ctx, user: ctx.user } });
  if (!result.ok) {
    const { error } = result;
    throw error.code === "INTERNAL_SERVER_ERROR" && error.cause ? mapError(error.cause) : error;
  }
  return result;
});

/** Requires a signed-in *server admin*. Defense-in-depth over the admin()
 * plugin's own checks (which guard the auth.api.* user-management calls); this
 * gates the instance-config and server-invite procedures below. */
const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "server admin only" });
  }
  return next();
});

const uuid = z.string().uuid();

export const appRouter = t.router({
  workspaces: t.router({
    mine: protectedProcedure.query(({ ctx }) => ctx.services.workspaces.listMine()),
    members: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.workspaces.members(input.workspaceId)),
    create: protectedProcedure
      .input(z.object({ name: nameSchema, slug: nameSchema }))
      .mutation(async ({ ctx, input }) => {
        // Instance policy: the admin can turn off team-workspace creation for
        // regular members (signup's personal workspace is unaffected — that's
        // provisioned by the auth hook, not this procedure).
        if (ctx.user.role !== "admin") {
          const settings = await ctx.services.instance.getSettings();
          if (!settings.allowWorkspaceCreation) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Workspace creation is disabled on this server.",
            });
          }
        }
        return ctx.services.workspaces.create(input);
      }),
    createInvite: protectedProcedure
      .input(
        z.object({
          workspaceId: uuid,
          role: z.enum(["member", "admin"]).optional(),
          email: z.string().email().optional(),
          expiresInDays: z.number().int().positive().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const invite = await ctx.services.workspaces.createInvite(input);
        await ctx.services.settings.recordAudit({
          workspaceId: invite.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "invite_create",
          detail: `${input.email ?? "anyone with the link"} role=${invite.role}`,
        });
        // Deliver by email when addressed and the instance has SMTP; a mail
        // failure downgrades to the copy-link flow instead of failing the invite.
        let emailed = false;
        if (input.email && ctx.mailer) {
          const ws = (await ctx.services.workspaces.listMine()).find(
            (w) => w.id === input.workspaceId,
          );
          try {
            await ctx.mailer.send({
              to: input.email,
              subject: `You're invited to ${ws?.name ?? "a workspace"} on Tandem`,
              text: [
                `${ctx.user.name || ctx.user.email} invited you to the "${ws?.name ?? "workspace"}" workspace.`,
                "",
                `Accept the invite: ${ctx.appUrl}/invite?token=${invite.token}`,
                "",
                "The link is single-use.",
              ].join("\n"),
            });
            emailed = true;
          } catch (err) {
            console.error("invite email failed", err);
          }
        }
        return { ...invite, emailed };
      }),
    acceptInvite: protectedProcedure
      .input(z.object({ token: z.string().min(1).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const ws = await ctx.services.workspaces.acceptInvite(input.token);
        await ctx.services.settings.recordAudit({
          workspaceId: ws.id,
          userId: ctx.user.id,
          ai: false,
          action: "invite_accept",
          detail: "joined via invite link",
        });
        return ws;
      }),
  }),

  groups: t.router({
    list: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.groups.list(input.workspaceId)),
    create: protectedProcedure
      .input(z.object({ workspaceId: uuid, name: nameSchema }))
      .mutation(({ ctx, input }) =>
        ctx.services.groups.create(input.workspaceId, input.name),
      ),
    addMember: protectedProcedure
      .input(z.object({ groupId: uuid, userId: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }) =>
        ctx.services.groups.addMember(input.groupId, input.userId),
      ),
    removeMember: protectedProcedure
      .input(z.object({ groupId: uuid, userId: z.string().min(1).max(200) }))
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
          name: nameSchema,
          slug: nameSchema,
          description: descriptionSchema.optional(),
          workspaceId: uuid.optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.collections.create(input)),
    update: protectedProcedure
      .input(
        z.object({
          id: uuid,
          name: nameSchema.optional(),
          description: descriptionSchema.optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const { id, ...patch } = input;
        return ctx.services.collections.update(id, patch);
      }),
    move: protectedProcedure
      .input(z.object({ id: uuid, position: positionSchema }))
      .mutation(async ({ ctx, input }) => {
        const col = await ctx.services.collections.move(input.id, input.position);
        // A null row on an RLS-scoped write means denied, not "not found".
        if (!col) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot reorder this collection." });
        return col;
      }),
    delete: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(({ ctx, input }) => ctx.services.collections.softDelete(input.id)),
    setDefaultRole: protectedProcedure
      .input(z.object({ id: uuid, role: z.enum(["none", "read", "read_write"]) }))
      .mutation(async ({ ctx, input }) => {
        await ctx.services.collections.setDefaultRole(input.id, input.role);
        await ctx.services.settings.recordAudit({
          workspaceId: await ctx.services.collections.workspaceIdOf(input.id),
          userId: ctx.user.id,
          ai: false,
          action: "share_default_role",
          detail: `collection=${input.id} role=${input.role}`,
        });
      }),
    grant: protectedProcedure
      .input(
        z.object({
          id: uuid,
          principalType: z.enum(["user", "group"]),
          principalId: z.string().min(1).max(200),
          role: z.enum(["read", "read_write"]),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await ctx.services.collections.grant(
          input.id,
          input.principalType,
          input.principalId,
          input.role,
        );
        await ctx.services.settings.recordAudit({
          workspaceId: await ctx.services.collections.workspaceIdOf(input.id),
          userId: ctx.user.id,
          ai: false,
          action: "share_grant",
          detail: `collection=${input.id} ${input.principalType}=${input.principalId} role=${input.role}`,
        });
      }),
    revoke: protectedProcedure
      .input(
        z.object({
          id: uuid,
          principalType: z.enum(["user", "group"]),
          principalId: z.string().min(1).max(200),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await ctx.services.collections.revoke(input.id, input.principalType, input.principalId);
        await ctx.services.settings.recordAudit({
          workspaceId: await ctx.services.collections.workspaceIdOf(input.id),
          userId: ctx.user.id,
          ai: false,
          action: "share_revoke",
          detail: `collection=${input.id} ${input.principalType}=${input.principalId}`,
        });
      }),
    permissions: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.collections.listPermissions(input.id)),
  }),

  documents: t.router({
    tree: protectedProcedure
      .input(z.object({ collectionId: uuid }))
      .query(({ ctx, input }) => ctx.services.documentTree.tree(input.collectionId)),

    // Metadata only (no body/binary) — what the editor header needs. The body
    // itself always arrives over the Yjs collab channel.
    getMeta: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.getMeta(input.id)),

    getMetaMany: protectedProcedure
      .input(z.object({ ids: documentIdsSchema }))
      .query(({ ctx, input }) => ctx.services.documents.getMetaMany(input.ids)),

    create: protectedProcedure
      .input(
        z.object({ ...documentCreateShape, tags: tagsSchema.optional() }),
      )
      .mutation(({ ctx, input }) => ctx.services.documents.create(input)),

    update: protectedProcedure
      .input(
        z.object(documentUpdateShape),
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...patch } = input;
        const doc = await ctx.services.documents.update(id, patch);
        // A null row on an RLS-scoped write means denied, not "not found".
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot edit this document." });
        // The title lives outside the CRDT body, so collaborators viewing the
        // doc need a ping to refetch it — otherwise a rename stays stale.
        if (patch.title !== undefined) ctx.notifyDocument?.(id, "meta");
        return doc;
      }),

    move: protectedProcedure
      .input(
        z.object(documentMoveShape),
      )
      .mutation(({ ctx, input }) => {
        const { id, ...target } = input;
        return ctx.services.documentTree.move(id, target);
      }),

    archive: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const doc = await ctx.services.documentTree.archive(input.id);
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot archive this document." });
        return doc;
      }),

    restore: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const doc = await ctx.services.documentTree.restore(input.id);
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot restore this document." });
        return doc;
      }),

    delete: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const deleted = await ctx.services.documentTree.softDelete(input.id);
        if (!deleted) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot delete this document." });
      }),

    getTrashed: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documentTree.getTrashed(input.id)),

    listTrash: protectedProcedure
      .input(z.object({ collectionId: uuid }))
      .query(({ ctx, input }) => ctx.services.documentTree.listTrash(input.collectionId)),

    restoreFromTrash: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const doc = await ctx.services.documentTree.restoreFromTrash(input.id);
        if (!doc) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot restore this document." });
        return doc;
      }),

    purge: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const purged = await ctx.services.documentTree.purge(input.id);
        if (!purged) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot delete this document." });
      }),

    duplicate: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(({ ctx, input }) => ctx.services.documents.duplicate(input.id)),

    // Single-document markdown, for the per-document download. The body
    // otherwise only travels over the Yjs channel.
    getMarkdown: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(async ({ ctx, input }) => {
        const doc = await ctx.services.documents.get(input.id);
        if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found." });
        return { title: doc.title, markdown: ctx.services.documents.toMarkdown(doc) };
      }),

    listArchived: protectedProcedure
      .input(z.object({ collectionId: uuid }))
      .query(({ ctx, input }) => ctx.services.documentTree.listArchived(input.collectionId)),

    myTodos: protectedProcedure.query(({ ctx }) => ctx.services.documentQueries.listMyTodos()),

    hasAny: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.hasAnyInWorkspace(input.workspaceId)),

    listTags: protectedProcedure.query(({ ctx }) => ctx.services.documentQueries.listTags()),

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

    properties: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.types.view(input.id)),

    // Attach a type, or detach with null; detaching keeps every value. The
    // type's list fields start here as empty arrays, in one serialized write,
    // so two people adding a page's first values can't each create the array
    // and lose one add.
    setType: protectedProcedure
      .input(z.object({ id: uuid, typeId: uuid.nullable() }))
      .mutation(async ({ ctx, input }) => {
        if (!(await ctx.services.types.setDocumentType(input.id, input.typeId))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You cannot edit this document." });
        }
        const view = await ctx.services.types.view(input.id);
        const lists: PropertyOp[] = view.fields
          .filter((f) => input.typeId !== null && f.typeId === input.typeId && isListKind(f.kind))
          .map((f) => ({ op: "add", field: f.id, values: [] }));
        if (lists.length > 0) await writeProperties(ctx, input.id, lists);
        ctx.notifyDocument?.(input.id, "meta");
        return view;
      }),

    // A per-field patch through the live doc as the human, like restore.
    setProperties: protectedProcedure
      .input(z.object({ id: uuid, ...propertyPatchShape }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...patch } = input;
        await writeProperties(ctx, id, await ctx.services.types.planPatch(id, patch));
        return ctx.services.types.view(id);
      }),

    backlinks: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documentQueries.backlinks(input.id)),

    search: protectedProcedure
      .input(
        z.object(documentSearchShape),
      )
      .query(({ ctx, input }) => {
        const { query, ...opts } = input;
        return ctx.services.documentQueries.search(query, opts);
      }),
  }),

  templates: t.router({
    list: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.templates.list(input.workspaceId)),

    defaultFor: protectedProcedure
      .input(z.object({ collectionId: uuid, parentDocumentId: uuid.nullable() }))
      .query(({ ctx, input }) =>
        ctx.services.templates.defaultFor(input.collectionId, input.parentDocumentId),
      ),

    templatize: protectedProcedure
      .input(z.object({ documentId: uuid, name: titleSchema }))
      .mutation(({ ctx, input }) => ctx.services.templates.templatize(input.documentId, input.name)),

    untemplatize: protectedProcedure
      .input(z.object({ documentId: uuid }))
      .mutation(async ({ ctx, input }) => {
        if (!(await ctx.services.templates.untemplatize(input.documentId))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You cannot change this template." });
        }
      }),

    setDefault: protectedProcedure
      .input(
        z.object({
          target: z.union([z.object({ collectionId: uuid }), z.object({ documentId: uuid })]),
          templateId: uuid.nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!(await ctx.services.templates.setDefault(input.target, input.templateId))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You cannot change this default." });
        }
      }),

    instantiate: protectedProcedure
      .input(
        z.object({
          templateId: uuid.nullable().optional(),
          collectionId: uuid,
          parentDocumentId: uuid.nullable().optional(),
          variables: templateVariablesSchema.optional(),
          dryRun: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { document, ...plan } = await ctx.services.templates.instantiate(input);
        return { ...plan, documentId: document?.id ?? null };
      }),
  }),

  // Types and fields: any member reads them; defining them is owner/admin
  // only (service + RLS) and audited, since an option rename silently
  // changes what every page holding it says.
  types: t.router({
    list: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.types.listTypes(input.workspaceId)),

    fields: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.types.listFields(input.workspaceId)),

    create: protectedProcedure
      .input(z.object({ workspaceId: uuid, name: nameSchema }))
      .mutation(async ({ ctx, input }) => {
        const type = await ctx.services.types.createType(input.workspaceId, input.name);
        await ctx.services.settings.recordAudit({
          workspaceId: type.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "define_type",
          detail: `type "${type.name}"`,
        });
        return type;
      }),

    rename: protectedProcedure
      .input(z.object({ id: uuid, name: nameSchema }))
      .mutation(async ({ ctx, input }) => {
        const type = await ctx.services.types.renameType(input.id, input.name);
        await ctx.services.settings.recordAudit({
          workspaceId: type.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "rename_type",
          detail: `type ${type.id} is now "${type.name}"`,
        });
        return type;
      }),

    delete: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        const type = await ctx.services.types.deleteType(input.id);
        await ctx.services.settings.recordAudit({
          workspaceId: type.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "delete_type",
          detail: `type "${type.name}"`,
        });
      }),

    createField: protectedProcedure
      .input(
        z.object({
          workspaceId: uuid,
          typeId: uuid.nullable(),
          key: fieldKeySchema,
          label: nameSchema.optional(),
          kind: z.enum(FIELD_KINDS),
          options: z.array(nameSchema).max(100).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const field = await ctx.services.types.createField(input);
        await ctx.services.settings.recordAudit({
          workspaceId: field.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "define_field",
          detail: `field "${field.key}" (${field.kind})`,
        });
        return field;
      }),

    updateField: protectedProcedure
      .input(
        z.object({
          id: fieldKeySchema,
          key: fieldKeySchema.optional(),
          label: nameSchema.optional(),
          kind: z.enum(FIELD_KINDS).optional(),
          position: positionSchema.optional(),
          options: z
            .array(z.object({ id: fieldKeySchema.optional(), label: nameSchema }))
            .max(100)
            .optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...patch } = input;
        const field = await ctx.services.types.updateField(id, patch);
        await ctx.services.settings.recordAudit({
          workspaceId: field.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "update_field",
          detail: `field "${field.key}": ${Object.keys(patch).join(", ")}`,
        });
        return field;
      }),

    retireField: protectedProcedure
      .input(z.object({ id: fieldKeySchema }))
      .mutation(async ({ ctx, input }) => {
        const field = await ctx.services.types.retireField(input.id);
        await ctx.services.settings.recordAudit({
          workspaceId: field.workspaceId,
          userId: ctx.user.id,
          ai: false,
          action: "retire_field",
          detail: `field "${field.key}"`,
        });
      }),
  }),

  // Instance administration (server admins only). User management itself
  // (list/role/ban/delete) rides on the admin() plugin's authClient.admin.*
  // APIs, which run their own permission checks — only instance config and the
  // server-invite lifecycle live here.
  admin: t.router({
    getSettings: adminProcedure.query(({ ctx }) => ctx.services.instance.getSettings()),
    updateSettings: adminProcedure
      .input(
        z.object({
          registrationMode: z.enum(["open", "invite", "domain", "closed"]).optional(),
          allowedEmailDomains: z.array(z.string().max(253)).max(100).optional(),
          instanceName: nameSchema.optional(),
          allowWorkspaceCreation: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const settings = await ctx.services.instance.updateSettings(input);
        await ctx.services.settings.recordAudit({
          workspaceId: null,
          userId: ctx.user.id,
          ai: false,
          action: "admin_update_settings",
          detail: JSON.stringify(input),
        });
        return settings;
      }),
    createInvite: adminProcedure
      .input(
        z.object({
          email: z.string().email().optional(),
          role: z.enum(["user", "admin"]).optional(),
          expiresInDays: z.number().int().positive().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const invite = await ctx.services.instance.createInvite({
          ...input,
          createdBy: ctx.user.id,
        });
        await ctx.services.settings.recordAudit({
          workspaceId: null,
          userId: ctx.user.id,
          ai: false,
          action: "admin_create_invite",
          detail: `${input.email ?? "anyone with the link"} role=${input.role ?? "user"}`,
        });
        let emailed = false;
        if (input.email && ctx.mailer) {
          const settings = await ctx.services.instance.getSettings();
          try {
            await ctx.mailer.send({
              to: input.email,
              subject: `You're invited to ${settings.instanceName}`,
              text: [
                `${ctx.user.name || ctx.user.email} invited you to join ${settings.instanceName}.`,
                "",
                `Create your account: ${ctx.appUrl}/invite?token=${invite.token}`,
                "",
                "The link is single-use.",
              ].join("\n"),
            });
            emailed = true;
          } catch (err) {
            console.error("invite email failed", err);
          }
        }
        return { ...invite, emailed };
      }),
    listInvites: adminProcedure.query(({ ctx }) => ctx.services.instance.listInvites()),
    revokeInvite: adminProcedure
      .input(z.object({ id: uuid }))
      .mutation(async ({ ctx, input }) => {
        await ctx.services.instance.revokeInvite(input.id);
        await ctx.services.settings.recordAudit({
          workspaceId: null,
          userId: ctx.user.id,
          ai: false,
          action: "admin_revoke_invite",
          detail: input.id,
        });
      }),
    audit: adminProcedure.query(({ ctx }) => ctx.services.settings.instanceAuditTrail()),
  }),

  settings: t.router({
    get: protectedProcedure.query(async ({ ctx }) => ({
      mcpEnabled: await ctx.services.settings.mcpEnabled(),
    })),
    setMcpEnabled: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.services.settings.setMcpEnabled(input.enabled)),
    // Sidebar fold state lives apart from `get` so the two invalidate independently.
    sidebar: protectedProcedure.query(({ ctx }) => ctx.services.settings.sidebarState()),
    setSidebarNode: protectedProcedure
      .input(
        z.object({
          kind: z.enum(["collection", "doc"]),
          id: uuid,
          expanded: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.services.settings.setSidebarNode(input.kind, input.id, input.expanded),
      ),
    backupCodes: protectedProcedure.query(async ({ ctx }) => ({
      remaining: (await ctx.countBackupCodes?.(ctx.user.id)) ?? null,
    })),
    audit: protectedProcedure
      .input(z.object({ workspaceId: uuid }))
      .query(({ ctx, input }) => ctx.services.settings.auditTrail(input.workspaceId)),
  }),

  notifications: t.router({
    list: protectedProcedure
      .input(z.object({ workspaceId: uuid.optional() }))
      .query(({ ctx, input }) => ctx.services.notifications.listMine(input.workspaceId)),
    unreadCount: protectedProcedure.query(({ ctx }) =>
      ctx.services.notifications.unreadCount(),
    ),
    markRead: protectedProcedure
      .input(z.object({ id: uuid }))
      .mutation(({ ctx, input }) => ctx.services.notifications.markRead(input.id)),
    markAllRead: protectedProcedure.mutation(({ ctx }) =>
      ctx.services.notifications.markAllRead(),
    ),
  }),

  favorites: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.services.favorites.list()),
    add: protectedProcedure
      .input(z.object({ documentId: uuid }))
      .mutation(({ ctx, input }) => ctx.services.favorites.add(input.documentId)),
    remove: protectedProcedure
      .input(z.object({ documentId: uuid }))
      .mutation(({ ctx, input }) => ctx.services.favorites.remove(input.documentId)),
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
        // Inbox entries for thread participants + @mentions. Best-effort.
        void ctx.services.documents
          .getMeta(input.documentId)
          .then((meta) =>
            meta
              ? ctx.services.notifications.onCommentCreated({
                  comment,
                  workspaceId: meta.workspaceId,
                  documentTitle: meta.title,
                  actor: { userId: ctx.user.id, name: ctx.user.name, ai: false },
                })
              : undefined,
          )
          .catch((err) => console.error("comment notification failed", err));
        return comment;
      }),
    setResolved: protectedProcedure
      .input(z.object({ id: uuid, resolved: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const comment = await ctx.services.comments.setResolved(input.id, input.resolved);
        ctx.notifyDocument?.(comment.documentId, "comments");
        if (input.resolved && comment.authorId !== ctx.user.id) {
          void ctx.services.documents
            .getMeta(comment.documentId)
            .then((meta) =>
              meta
                ? ctx.services.notifications.onCommentResolved({
                    comment,
                    workspaceId: meta.workspaceId,
                    documentTitle: meta.title,
                    actor: { userId: ctx.user.id, name: ctx.user.name, ai: false },
                  })
                : undefined,
            )
            .catch((err) => console.error("resolve notification failed", err));
        }
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
/** What each procedure returns over the wire (dates arrive as strings). */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
