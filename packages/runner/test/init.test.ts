import { describe, expect, it } from "vitest";
import { runnerEnv, serviceEnv } from "../src/init.js";
import { resolveRunnerOptions } from "../src/options.js";
import { tokenReadable } from "../src/proc.js";

describe("witden-init", () => {
  const env = {
    HOME: "/home/witden",
    PATH: "/usr/bin",
    DISPLAY: ":1",
    WITDEN_RUNNER_TOKEN: "wdr_secret",
    NODE_OPTIONS: "--require /home/witden/hook.js",
    NODE_PATH: "/home/witden/lib",
  };

  it("gives the token to the runner only", () => {
    const services = serviceEnv(env);
    expect(services.WITDEN_RUNNER_TOKEN).toBeUndefined();
    // the services' environment is otherwise the container's
    expect(services).toMatchObject({ HOME: "/home/witden", DISPLAY: ":1", NODE_OPTIONS: env.NODE_OPTIONS });
    expect(runnerEnv(env, "/opt/witden/runner").WITDEN_RUNNER_TOKEN).toBe("wdr_secret");
  });

  it("leaves the runner nothing that loads code the computer's user can write", () => {
    const runner = runnerEnv(env, "/opt/witden/runner");
    // CommonJS falls back to $HOME/.node_modules: HOME is the runner's own directory
    expect(runner).toMatchObject({ HOME: "/opt/witden/runner", WITDEN_HOME: "/home/witden", WS_NO_BUFFER_UTIL: "1" });
    expect(runner.NODE_OPTIONS).toBeUndefined();
    expect(runner.NODE_PATH).toBeUndefined();
    // and the runner still works in the user's home
    expect(resolveRunnerOptions({}, runner)).toMatchObject({ home: "/home/witden", workdir: "/home/witden" });
  });

  it("reports a token other processes could read", () => {
    // This test process can be inspected by its user (it runs from a readable node), so a token it held would be
    // exposed; the computer images are checked in docker.e2e.test.ts.
    expect(tokenReadable("wdr_secret")).toBe(process.getuid?.() !== 0);
    expect(tokenReadable("")).toBe(false);
  });
});
