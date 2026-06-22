import { initTRPC } from "@trpc/server";
import { z } from "zod";
import type { Services } from "./services.js";

export interface Context {
  services: Services;
}

const t = initTRPC.context<Context>().create();

const uuid = z.string().uuid();

export const appRouter = t.router({
  collections: t.router({
    list: t.procedure.query(({ ctx }) => ctx.services.collections.list()),
    create: t.procedure
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

    create: t.procedure
      .input(
        z.object({
          collectionId: uuid,
          title: z.string().optional(),
          markdown: z.string().optional(),
          parentDocumentId: uuid.optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.documents.create(input)),

    update: t.procedure
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

    move: t.procedure
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

    archive: t.procedure
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
