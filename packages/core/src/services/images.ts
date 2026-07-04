import { eq } from "drizzle-orm";
import {
  images,
  runAsActor,
  SYSTEM,
  type Actor,
  type Database,
  type Image,
} from "@tandem/db";

export class ImageService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  /** Record image metadata in a workspace (RLS enforces membership). */
  async create(input: {
    workspaceId: string;
    uploadedBy: string;
    mime: string;
    size: number;
  }): Promise<Image> {
    return this.exec(async (db) => {
      const [row] = await db.insert(images).values(input).returning();
      return row!;
    });
  }

  /** Fetch metadata — RLS returns it only to members of the image's workspace. */
  async get(id: string): Promise<Image | null> {
    return this.exec(async (db) => {
      const [row] = await db.select().from(images).where(eq(images.id, id));
      return row ?? null;
    });
  }
}
