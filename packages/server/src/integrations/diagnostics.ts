/** Integration failures belong to the console, never to mirrored chat messages or model context. */
import type { Db } from "../db/client.js";
import type { Connection, Message } from "../db/schema.js";
import { redact, secretBox } from "../security/crypto.js";
import { audit } from "../services/audit.js";

export async function integrationError(
  db: Db,
  conn: Connection,
  msg: Message,
  stage: "download" | "upload" | "send" | "format",
  error: unknown,
  file?: { name?: string; id?: string },
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const credentials = conn.credentialsEncrypted ? JSON.parse(secretBox().decrypt(conn.credentialsEncrypted)) : {};
  const secrets = Object.values(credentials).filter((v): v is string => typeof v === "string");
  let hint: string | undefined;
  if (conn.platform === "feishu" && /99991672/.test(reason)) {
    hint =
      stage === "download"
        ? "在飞书开放平台为应用开通 im:message:readonly（已有 im:message 或 im:message.history:readonly 也可），发布新版本并等待审批生效后，在接入详情重新检测权限，再重新发送附件。"
        : stage === "upload"
          ? "在飞书开放平台为应用开通 im:resource，发布新版本并等待审批生效后，在接入详情重新检测权限。"
          : "在飞书开放平台检查错误中列出的应用权限，发布新版本并等待审批生效后，在接入详情重新检测权限。";
  }
  await audit(db, "integration.error", {
    outcome: "error",
    connectionId: conn.id,
    topicId: msg.topicId,
    resourceType: "message",
    resourceId: msg.id,
    detail: {
      stage,
      error: redact(reason, secrets).slice(0, 2000),
      ...(hint ? { hint } : {}),
      ...(file?.name ? { file_name: file.name } : {}),
      ...(file?.id ? { file_id: file.id } : {}),
    },
  });
}
