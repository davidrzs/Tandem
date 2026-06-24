import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Services } from "./services.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Context {
  services: Services;
  user: AuthUser | null;
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

    get: protectedProcedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.get(input.id)),

    // Metadata only (no body/binary) — what the editor header needs.
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
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.documents.create(input)),

    update: protectedProcedure
      .input(
        z.object({
          id: uuid,
          title: z.string().optional(),
          markdown: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const { id, ...patch } = input;
        return ctx.services.documents.update(id, patch);
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
      .mutation(({ ctx, input }) => ctx.services.documents.archive(input.id)),

    search: protectedProcedure
      .input(
        z.object({
          query: z.string().min(1),
          collectionId: uuid.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .query(({ ctx, input }) => {
        const { query, ...opts } = input;
        return ctx.services.documents.search(query, opts);
      }),
  }),
});

export type AppRouter = typeof appRouter;
