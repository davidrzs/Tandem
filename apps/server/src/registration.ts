import { and, eq, isNull } from "drizzle-orm";
import { APIError } from "better-auth/api";
import {
  instanceInvites,
  instanceSettings,
  user,
  workspaceInvites,
  type Database,
} from "@tandem/db";

/** The domain part of an email, lowercased (everything after the last @). */
function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

interface MatchedInvite {
  kind: "instance" | "workspace";
  /** Server role granted by an instance invite ('user' | 'admin'). */
  role?: string;
}

/** A pending (unaccepted, unexpired) invite for `token` in either invite table,
 * whose optional email binding matches `email`. Server invites and workspace
 * invites are both honored so a gated instance still lets invited people sign
 * up (workspace invites keep the existing sharing flow working for new users). */
async function findInvite(
  db: Database,
  token: string,
  email: string,
): Promise<MatchedInvite | null> {
  const [ii] = await db
    .select({
      email: instanceInvites.email,
      expiresAt: instanceInvites.expiresAt,
      role: instanceInvites.role,
    })
    .from(instanceInvites)
    .where(and(eq(instanceInvites.token, token), isNull(instanceInvites.acceptedAt)));
  const [wi] = ii
    ? [undefined]
    : await db
        .select({ email: workspaceInvites.email, expiresAt: workspaceInvites.expiresAt })
        .from(workspaceInvites)
        .where(and(eq(workspaceInvites.token, token), isNull(workspaceInvites.acceptedAt)));
  const invite = ii ?? wi;
  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return null;
  if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) return null;
  return ii ? { kind: "instance", role: ii.role } : { kind: "workspace" };
}

/**
 * Decide whether a signup for `email` is allowed and what server role it gets.
 * Returns the data patch to merge into the new user: { role: 'admin' } for the
 * bootstrap first user and for admin-role instance invites; {} otherwise.
 * Throws a Better Auth APIError (clean 403) when the instance's registration
 * policy forbids the signup.
 *
 * The admin() plugin already stamps the default 'user' role before this runs,
 * so an empty patch leaves a normal member; the first-ever user is promoted to
 * admin and is always allowed (you can't gate the founder out).
 */
export async function registrationRole(
  db: Database,
  email: string,
  inviteToken?: string | null,
): Promise<{ role?: string }> {
  const [firstExisting] = await db.select({ id: user.id }).from(user).limit(1);
  if (!firstExisting) return { role: "admin" };

  if (inviteToken) {
    const invite = await findInvite(db, inviteToken, email);
    // An admin-role instance invite grants the server-admin role at signup.
    if (invite) return invite.role === "admin" ? { role: "admin" } : {};
  }

  const [settings] = await db.select().from(instanceSettings).limit(1);
  const mode = settings?.registrationMode ?? "open";
  switch (mode) {
    case "open":
      return {};
    case "closed":
      throw new APIError("FORBIDDEN", {
        message: "Registration is closed on this server.",
      });
    case "invite":
      throw new APIError("FORBIDDEN", {
        message: "An invite is required to sign up on this server.",
      });
    case "domain": {
      const domains = (settings?.allowedEmailDomains ?? []).map((d) => d.toLowerCase());
      if (domains.includes(domainOf(email))) return {};
      throw new APIError("FORBIDDEN", {
        message: "Your email domain isn't allowed to sign up on this server.",
      });
    }
    default:
      return {};
  }
}

/**
 * Single-use: burn the instance invite that admitted this signup. Guarded by
 * accepted_at IS NULL so a concurrent double-redeem consumes it exactly once.
 * Workspace invites are not consumed here — acceptInvite does that when the
 * new user actually joins the workspace.
 */
export async function consumeInstanceInvite(
  db: Database,
  token: string,
  userId: string,
): Promise<void> {
  await db
    .update(instanceInvites)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(and(eq(instanceInvites.token, token), isNull(instanceInvites.acceptedAt)));
}

/** Header carrying an invite token through signup (see registrationRole). The
 * body is Zod-validated and may drop unknown keys; headers pass through intact. */
export const INVITE_TOKEN_HEADER = "x-tandem-invite-token";
