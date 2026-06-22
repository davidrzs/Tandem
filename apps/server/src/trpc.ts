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

const t = initTRPC.context<Context>().create();

/** Requires a signed-in user; narrows ctx.user to non-null for the handler. */
const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const uuid = z.string().uuid();

export const appRouter = t.router({
  collections: t.router({
    list: t.procedure.query(({ ctx }) => ctx.services.collections.list()),
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          slug: z.string().min(1),
          description: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.collections.create(input)),
  }),

  documents: t.router({
    tree: t.procedure
      .input(z.object({ collectionId: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.tree(input.collectionId)),

    get: t.procedure
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) => ctx.services.documents.get(input.id)),

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

    search: t.procedure
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
