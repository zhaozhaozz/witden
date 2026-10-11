import type { RunnerInfo, ScreenCaptureResult } from "@witden/shared";
import type { Env, OpContext } from "../context.js";
import { remainingMs } from "../context.js";
import { OpError } from "../errors.js";
import { optEnum, optInt, optString } from "../params.js";
import { runTool } from "../tools.js";
import { pngSize, sleep } from "../util.js";

const BUTTONS = { left: "1", middle: "2", right: "3" } as const;
const ACTIONS = ["move", "click", "double_click", "drag", "scroll"] as const;
/** xdotool key syntax: space separated combos of keysym names joined with "+". */
const KEY_COMBO = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;
const MAX_COORD = 32767;

/** Screen capture and mouse / keyboard input on the computer's X11 desktop (xdotool, ImageMagick). */
export class Desktop {
  private cachedSize: { width: number; height: number } | null = null;

  constructor(
    private readonly env: Env,
    readonly display: string | null,
    private readonly vncPort: number,
    private readonly vncViewPort: number,
  ) {}

  get available(): boolean {
    return !!this.display;
  }

  private require(): string {
    if (!this.display) throw new OpError("unsupported", "this computer has no desktop");
    return this.display;
  }

  private x11(bin: string, args: string[], ctx: OpContext | null, maxBytes?: number) {
    const display = this.require();
    return runTool(bin, args, {
      env: this.env.childEnv({ DISPLAY: display }),
      cwd: this.env.home,
      signal: ctx?.signal,
      timeoutMs: ctx ? remainingMs(ctx) : 10_000,
      maxBytes,
    });
  }

  private async xdotool(args: string[], ctx: OpContext | null): Promise<string> {
    const res = await this.x11("xdotool", args, ctx);
    if (res.code !== 0) throw new OpError("failed", `xdotool failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    return res.stdout.toString("utf8").trim();
  }

  async size(ctx: OpContext | null): Promise<{ width: number; height: number }> {
    const out = await this.xdotool(["getdisplaygeometry"], ctx);
    const [width, height] = out.split(/\s+/).map(Number);
    if (!width || !height) throw new OpError("failed", `unexpected display geometry: ${out}`);
    this.cachedSize = { width, height };
    return { width, height };
  }

  /** Desktop description for `hello`; waits briefly for an X server that is still starting. */
  async describe(): Promise<RunnerInfo["desktop"]> {
    if (!this.display) return null;
    let size = this.cachedSize;
    for (let attempt = 0; !size && attempt < 10; attempt++) {
      size = await this.size(null).catch(() => null);
      if (!size) await sleep(500);
    }
    return {
      display: this.display,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      vncPort: this.vncPort,
      vncViewPort: this.vncViewPort,
    };
  }

  async capture(_params: Record<string, unknown>, ctx: OpContext): Promise<ScreenCaptureResult> {
    const res = await this.x11("import", ["-window", "root", "png:-"], ctx, 64 * 1024 * 1024);
    if (res.code !== 0 || res.stdout.length === 0) {
      throw new OpError("failed", `screenshot failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    const { width, height } = pngSize(res.stdout);
    return { pngBase64: res.stdout.toString("base64"), width, height };
  }

  async mouse(params: Record<string, unknown>, ctx: OpContext): Promise<Record<string, unknown>> {
    this.require();
    const action = optEnum(params, "action", ACTIONS);
    if (!action) throw new OpError("invalid", `params.action must be one of ${ACTIONS.join(", ")}`);
    const button = BUTTONS[optEnum(params, "button", ["left", "middle", "right"] as const) ?? "left"];
    const coord = (key: string) => {
      const value = optInt(params, key, 0, MAX_COORD);
      if (value === undefined) throw new OpError("invalid", `${action} needs params.${key}`);
      return String(value);
    };
    const x = coord("x");
    const y = coord("y");
    let args: string[];
    switch (action) {
      case "move":
        args = ["mousemove", x, y];
        break;
      case "click":
        args = ["mousemove", x, y, "click", button];
        break;
      case "double_click":
        args = ["mousemove", x, y, "click", "--repeat", "2", "--delay", "80", button];
        break;
      case "drag":
        args = ["mousemove", x, y, "mousedown", button, "mousemove", coord("toX"), coord("toY"), "mouseup", button];
        break;
      case "scroll": {
        const amount = optInt(params, "amount", -100, 100) ?? 3;
        // Negative scrolls up (wheel button 4), positive down (5).
        args = ["mousemove", x, y, "click", "--repeat", String(Math.max(1, Math.abs(amount))), amount < 0 ? "4" : "5"];
        break;
      }
    }
    await this.xdotool(args, ctx);
    return { action, x: Number(x), y: Number(y) };
  }

  async keyboard(params: Record<string, unknown>, ctx: OpContext): Promise<Record<string, unknown>> {
    this.require();
    const text = optString(params, "text", 20_000);
    const keys = optString(params, "keys", 1000)?.trim();
    if (!text && !keys) throw new OpError("invalid", "params.text or params.keys is required");
    const combos = keys ? keys.split(/\s+/) : [];
    if (combos.some((c) => !KEY_COMBO.test(c))) {
      throw new OpError("invalid", 'keys must look like "Return", "ctrl+l" or "ctrl+shift+t" (space separated)');
    }
    if (text) await this.xdotool(["type", "--delay", "12", "--", text], ctx);
    if (combos.length) await this.xdotool(["key", "--", ...combos], ctx);
    return { typed: text?.length ?? 0, keys: combos };
  }
}
