/**
 * System software of a computer. Nothing inside a computer is root: the Docker Manager installs and removes
 * Debian packages for it, running apt as root with a fixed command. Two uses:
 *
 * - now: a role (tools `install_packages`, `uninstall_packages`) or a person asks for packages. They stay until
 *   the container is recreated (reset, restore);
 * - the computer's software list: installed, when missing, whenever the computer starts, so it survives resets.
 *   A new computer gets its template's list; people and the computer's roles change it.
 */
import { eq } from "drizzle-orm";
import { type Db, db as getDb, transaction } from "../db/client.js";
import { type ComputerInstance, computerInstances } from "../db/schema.js";
import { runtime } from "../runtime.js";
import { publish } from "./events.js";
import { validateSoftwareList } from "./templates.js";

export interface SoftwareStatus {
  state: "installing" | "ok" | "failed";
  /** The list as it was installed. */
  packages: string[];
  /** Packages of the list that are not installed afterwards. */
  missing?: string[];
  /** Why (the end of apt's output, or the error). */
  error?: string;
  at: string;
}

const tail = (text: string, n = 2000) => (text.length > n ? `...${text.slice(-n)}` : text);

async function setStatus(id: string, status: SoftwareStatus | null): Promise<void> {
  await transaction(async (tx) => {
    await tx.update(computerInstances).set({ softwareStatus: status }).where(eq(computerInstances.id, id));
    await publish(tx, "instance.software", { id, state: status?.state ?? null }, `instance:${id}`, "admin");
  });
}

/** Install what is missing from the computer's software list (after every start, or when a person asks). */
export async function installSoftwareList(id: string): Promise<SoftwareStatus | null> {
  const [inst] = await getDb().select().from(computerInstances).where(eq(computerInstances.id, id)).limit(1);
  if (!inst || inst.status !== "running" || !inst.containerId) return null;
  const packages = [...inst.software];
  if (!packages.length) {
    if (inst.softwareStatus) await setStatus(id, null);
    return null;
  }
  await setStatus(id, { state: "installing", packages, at: new Date().toISOString() });
  let status: SoftwareStatus;
  try {
    const r = await runtime().manager.packages(inst.containerId, { action: "install", packages });
    const missing = packages.filter((p) => !r.installed[p]);
    status = missing.length
      ? { state: "failed", packages, missing, error: tail(r.output), at: new Date().toISOString() }
      : { state: "ok", packages, at: new Date().toISOString() };
  } catch (err) {
    const error = (err as Error).message;
    status = { state: "failed", packages, missing: packages, error, at: new Date().toISOString() };
  }
  // A list changed meanwhile is installed by the next start or request; this records what was installed.
  await setStatus(id, status);
  return status;
}

/** Add and remove names (validated) in a computer's software list; returns the new list. */
export async function editSoftwareList(
  db: Db,
  inst: ComputerInstance,
  change: { add?: unknown; remove?: unknown; set?: unknown },
): Promise<string[]> {
  let list = change.set !== undefined ? validateSoftwareList(change.set) : [...inst.software];
  const add = change.add !== undefined ? validateSoftwareList(change.add) : [];
  const remove = new Set(change.remove !== undefined ? validateSoftwareList(change.remove) : []);
  list = validateSoftwareList([...list.filter((p) => !remove.has(p)), ...add.filter((p) => !list.includes(p))]);
  await db.update(computerInstances).set({ software: list }).where(eq(computerInstances.id, inst.id));
  await publish(db, "instance.software", { id: inst.id, list }, `instance:${inst.id}`, "admin");
  return list;
}
