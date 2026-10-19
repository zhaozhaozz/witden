import "@fastify/websocket";
/**
 * Live desktop for people (RFB over WebSocket, for noVNC) and the internal execution-gateway endpoint used
 * by workers running in their own process.
 *
 * The VNC servers inside a desktop computer listen on localhost only; the runner tunnels them over its hub
 * connection. Observers always get the view-only server; the control server is used only by someone with
 * instance.control who has taken over the computer (which pauses AI work there).
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  checkInternalToken,
  type GatewayRequest,
  type PackagesGatewayRequest,
  serializeError,
} from "../compute/gateway.js";
import { db as getDb, transaction } from "../db/client.js";
import { computerInstances } from "../db/schema.js";
import { runtime } from "../runtime.js";
import { hasPermission, Perm } from "../security/permissions.js";
import { audit } from "../services/audit.js";
import type { ConfigRequest } from "../services/config-access.js";
import { canObserveInstance, ensureUsable } from "../services/instances.js";
import { currentLease } from "../services/leases.js";
import { resolveToken } from "../services/users.js";
import { params, query } from "./http.js";

async function authorizeVnc(
  instanceId: string,
  token: string,
  mode: string,
): Promise<[number, { port: number; network: string; containerId: string | null; inst?: any }]> {
  return transaction(async (db) => {
    const user = await resolveToken(db, token);
    const [inst] = await db.select().from(computerInstances).where(eq(computerInstances.id, instanceId)).limit(1);
    if (!user) return [4401, {} as any];
    if (!inst || !(await canObserveInstance(db, user, instanceId))) return [4403, {} as any];
    const desktop = inst.spec.desktop ?? {};
    if (inst.spec.kind !== "desktop" || inst.status !== "running") return [4409, {} as any];
    const lease = await currentLease(db, inst.id);
    const control =
      mode === "control" &&
      (await hasPermission(db, user, Perm.INSTANCE_CONTROL, instanceId)) &&
      lease?.holderType === "user" &&
      lease.holderId === user.id;
    await audit(db, "instance.vnc", {
      actorType: "user",
      actorId: user.id,
      resourceType: "instance",
      resourceId: inst.id,
      instanceId: inst.id,
      detail: { mode: control ? "control" : "view" },
    });
    return [
      0,
      {
        port: control ? (desktop.vnc_port ?? 5900) : (desktop.vnc_view_port ?? 5901),
        network: inst.resources.network ?? "bridge",
        containerId: inst.containerId,
        inst,
      },
    ];
  });
}

export async function liveRoutes(app: FastifyInstance) {
  app.get("/api/instances/:id/vnc", { websocket: true }, async (socket, req) => {
    // Accepted already: closing with our own codes lets the client tell why.
    const [code, info] = await authorizeVnc(params(req).id, query(req).access_token ?? "", query(req).mode ?? "view");
    if (code) {
      socket.close(code);
      return;
    }
    const hub = runtime().hub;
    if (!hub) {
      socket.close(4501);
      return;
    }
    try {
      await ensureUsable(info.inst);
      const conn = await hub.connection(params(req).id, {
        containerId: info.containerId,
        network: info.network,
        waitMs: 15_000,
      });
      const stream = await conn.openStream(info.port);
      stream.onData((data) => socket.send(data));
      stream.onClose(() => socket.close(1000));
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) stream.send(new Uint8Array(data));
      });
      socket.on("close", () => stream.close());
    } catch {
      socket.close(1011);
    }
  });

  app.post("/internal/gateway/:op", async (req, reply) => {
    if (!checkInternalToken(req.headers.authorization, runtime().settings.internalToken)) {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized", message: "bad internal token" } });
    }
    const gateway = runtime().gateway;
    try {
      if (!gateway) throw new Error("no execution gateway in this process");
      const b: any = req.body ?? {};
      const op = params(req).op;
      const result =
        op === "execute"
          ? await gateway.execute(b as GatewayRequest)
          : op === "config"
            ? await gateway.config(b as ConfigRequest)
            : op === "packages"
              ? await gateway.packages(b as PackagesGatewayRequest)
              : await gateway.recover(String(b.taskId), String(b.toolCallId));
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
}

export { getDb };
