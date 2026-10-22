import { z } from "zod";

/**
 * Input bounds shared by every API surface (tRPC for the web app, MCP for
 * agents) so the two can't drift: one place decides how large a title, body
 * or search query may be. Shapes are plain objects so MCP's `inputSchema`
 * (a raw shape) and tRPC's `z.object(...)` can both use them.
 */
export const INPUT_LIMITS = {
  title: 500,
  /** Markdown body, in characters (~1MB of ASCII). */
  markdown: 1_000_000,
  searchQuery: 500,
  tags: 50,
  tag: 100,
  name: 200,
  description: 2_000,
  /** Documents per metadata batch (e.g. resolving a recents list). */
  metaBatch: 50,
} as const;

export const titleSchema = z.string().max(INPUT_LIMITS.title);
export const markdownSchema = z.string().max(INPUT_LIMITS.markdown);
export const tagSchema = z.string().max(INPUT_LIMITS.tag);
export const tagsSchema = z.array(tagSchema).max(INPUT_LIMITS.tags);
export const searchQuerySchema = z.string().max(INPUT_LIMITS.searchQuery);
export const nameSchema = z.string().min(1).max(INPUT_LIMITS.name);
export const descriptionSchema = z.string().max(INPUT_LIMITS.description);
export const positionSchema = z.number().finite();
export const documentIdsSchema = z.array(z.string().uuid()).max(INPUT_LIMITS.metaBatch);

const uuid = z.string().uuid();

export const documentCreateShape = {
  collectionId: uuid,
  title: titleSchema.optional(),
  markdown: markdownSchema.optional(),
  parentDocumentId: uuid.optional(),
};

export const documentUpdateShape = {
  id: uuid,
  title: titleSchema.optional(),
  tags: tagsSchema.optional(),
};

export const documentMoveShape = {
  id: uuid,
  parentDocumentId: uuid.nullable(),
  position: positionSchema.optional(),
};

export const documentSearchShape = {
  query: searchQuerySchema,
  collectionId: uuid.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tag: tagSchema.optional(),
};

/** Answers to a template's `{{name}}` prompts (and overrides of its built-ins). */
export const templateVariablesSchema = z
  .record(z.string().max(INPUT_LIMITS.tag), z.string().max(INPUT_LIMITS.description))
  .refine((vars) => Object.keys(vars).length <= INPUT_LIMITS.tags, "too many variables");

export const fieldKeySchema = z.string().trim().min(1).max(INPUT_LIMITS.tag);
const propertyValuesSchema = z
  .record(fieldKeySchema, z.unknown())
  .refine((values) => Object.keys(values).length <= INPUT_LIMITS.tags, "too many fields");

/** A property patch by field key: `set` replaces a value (a list field takes
 * the whole list), `unset` clears, `add` and `remove` change list fields. */
export const propertyPatchShape = {
  set: propertyValuesSchema.optional(),
  unset: z.array(fieldKeySchema).max(INPUT_LIMITS.tags).optional(),
  add: propertyValuesSchema.optional(),
  remove: propertyValuesSchema.optional(),
};
export const propertyPatchSchema = z.object(propertyPatchShape);
export type PropertyPatchInput = z.infer<typeof propertyPatchSchema>;
