import { createServer, type Server, type Socket } from "node:net";
import { decodeStreamFrame, encodeStreamFrame, type StreamCloseMessage } from "@witden/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRunner, waitUntil } from "./helpers.js";

let server: Server;
let port = 0;
const serverSockets: Socket[] = [];

beforeAll(async () => {
  server = createServer((socket) => {
    serverSockets.push(socket);
    socket.write("RFB 003.008\n");
    socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

describe("streams", () => {
  it("refuses ports outside the allowlist", async () => {
    const { core, hub } = makeRunner("streams-deny", { streamPorts: [5901] });
    core.handleMessage({ type: "stream.open", streamId: 3, port });
    const closed = await hub.waitFor<StreamCloseMessage>((m) => m.type === "stream.close" && m.streamId === 3);
    expect(closed.reason).toContain("not allowed");
    await core.shutdown();
  });

  it("tunnels bytes both ways and closes in both directions", async () => {
    const { core, hub } = makeRunner("streams", { streamPorts: [port] });
    core.handleMessage({ type: "stream.open", streamId: 7, port });
    await hub.waitFor((m) => m.type === "stream.opened" && m.streamId === 7);
    const received = () => Buffer.concat(hub.binary.map((f) => Buffer.from(decodeStreamFrame(f).payload))).toString();
    await waitUntil(() => received().startsWith("RFB 003."));
    core.handleBinary(encodeStreamFrame(7, Buffer.from("ping")));
    await waitUntil(() => received().includes("echo:ping"));
    expect(decodeStreamFrame(hub.binary[0]).streamId).toBe(7);

    // Hub-side close tears the socket down.
    const before = serverSockets.length;
    core.handleMessage({ type: "stream.close", streamId: 7 });
    await waitUntil(() => serverSockets[before - 1].destroyed || serverSockets[before - 1].readableEnded);

    // Server-side close is reported to the hub.
    core.handleMessage({ type: "stream.open", streamId: 8, port });
    await hub.waitFor((m) => m.type === "stream.opened" && m.streamId === 8);
    serverSockets[serverSockets.length - 1].end();
    await hub.waitFor((m) => m.type === "stream.close" && m.streamId === 8);
    await core.shutdown();
  });
});
