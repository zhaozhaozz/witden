import { eq, sql } from "drizzle-orm";
import type { Settings } from "../config.js";
import type { Db } from "../db/client.js";
import { newId } from "../db/ids.js";
import { apiSessions, type User, users } from "../db/schema.js";
import { BadRequest, Conflict, Unauthorized } from "../errors.js";
import { hashPassword, hashToken, newToken, verifyPassword } from "../security/crypto.js";
import { grant, Perm } from "../security/permissions.js";

export async function createUser(
  db: Db,
  opts: { name: string; email?: string | null; password?: string | null; isAdmin?: boolean },
): Promise<User> {
  const email = opts.email?.toLowerCase() ?? null;
  if (email) {
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new Conflict(`user with email ${email} already exists`);
  }
  if (opts.password != null && opts.password.length < 8)
    throw new BadRequest("password must have at least 8 characters");
  const [user] = await db
    .insert(users)
    .values({
      id: newId("usr"),
      name: opts.name,
      email,
      passwordHash: opts.password ? hashPassword(opts.password) : null,
      isAdmin: opts.isAdmin ?? false,
    })
    .returning();
  return user;
}

export async function getUser(db: Db, id: string | null | undefined): Promise<User | undefined> {
  if (!id) return undefined;
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function authenticate(db: Db, email: string, password: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user?.isActive || !verifyPassword(password, user.passwordHash)) {
    throw new Unauthorized("invalid email or password");
  }
  return user;
}

export async function issueToken(
  db: Db,
  user: User,
  opts: { kind?: "session" | "api"; name?: string | null; ttlHours?: number | null } = {},
): Promise<string> {
  const token = newToken();
  await db.insert(apiSessions).values({
    id: newId("ses"),
    userId: user.id,
    tokenHash: hashToken(token),
    kind: opts.kind ?? "session",
    name: opts.name ?? null,
    expiresAt: opts.ttlHours ? new Date(Date.now() + opts.ttlHours * 3600_000) : null,
  });
  return token;
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

export async function resolveToken(db: Db, token: string | null | undefined): Promise<User | null> {
  if (!token) return null;
  const [session] = await db
    .select()
    .from(apiSessions)
    .where(eq(apiSessions.tokenHash, hashToken(token)))
    .limit(1);
  if (!session || session.revoked) return null;
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) return null;
  const user = await getUser(db, session.userId);
  if (!user?.isActive) return null;
  // Recording use on every request would turn read-only traffic into writes; once every few minutes is enough.
  if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(apiSessions).set({ lastUsedAt: new Date() }).where(eq(apiSessions.id, session.id));
  }
  return user;
}

export async function revokeToken(db: Db, token: string): Promise<void> {
  await db
    .update(apiSessions)
    .set({ revoked: true })
    .where(eq(apiSessions.tokenHash, hashToken(token)));
}

export async function revokeUserSessions(db: Db, userId: string): Promise<void> {
  await db.update(apiSessions).set({ revoked: true }).where(eq(apiSessions.userId, userId));
}

/** First start: create the initial admin (if configured) and baseline grants. */
export async function bootstrap(db: Db, settings: Settings): Promise<void> {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  if (count === 0 && settings.bootstrapAdminEmail) {
    if (!settings.bootstrapAdminPassword) {
      throw new Error("WITDEN_BOOTSTRAP_ADMIN_PASSWORD is required with WITDEN_BOOTSTRAP_ADMIN_EMAIL");
    }
    await createUser(db, {
      name: settings.bootstrapAdminName,
      email: settings.bootstrapAdminEmail,
      password: settings.bootstrapAdminPassword,
      isAdmin: true,
    });
  }
  // Every member may open topics; everything else must be granted explicitly.
  await grant(db, Perm.TOPIC_CREATE);
}
