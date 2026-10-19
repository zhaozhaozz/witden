/**
 * Images and files between witden and Feishu.
 *
 * Out (``im:resource``): a role's attachments are uploaded first. Images (up to 10 MB, the formats Feishu shows)
 * go into the rich-text post with the words; other files (up to 30 MB) follow as file messages in the same place.
 * What Feishu will not take is linked to witden instead; diagnostics stay in the console.
 *
 * In (``im:message:readonly``): images and files people send, alone or inside a rich-text post, are listed with the
 * message and downloaded into the topic's files (up to 20 MB), so roles can look at them.
 */
import path from "node:path";
import type { Artifact } from "../db/schema.js";
import { consoleBase } from "../services/public-url.js";

export const MAX_IN_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const IMAGE_MIMES = /^image\/(png|jpe?g|gif|webp|bmp|tiff|heic|x-icon|vnd\.microsoft\.icon)$/;

/** How a file goes to Feishu: as an image, as a file of one of Feishu's types, or not at all (why). */
export function uploadKind(f: Artifact): { image: true } | { image: false; fileType: string } | { refused: string } {
  if (!f.size) return { refused: "文件是空的" };
  if (IMAGE_MIMES.test(f.mime) && f.size <= MAX_IMAGE_BYTES) return { image: true };
  if (f.size > MAX_FILE_BYTES) return { refused: "超过飞书的大小上限（图片 10 MB，文件 30 MB）" };
  const ext = path.extname(f.name).toLowerCase().slice(1);
  const fileType =
    ext === "pdf"
      ? "pdf"
      : ["doc", "docx"].includes(ext)
        ? "doc"
        : ["xls", "xlsx"].includes(ext)
          ? "xls"
          : ["ppt", "pptx"].includes(ext)
            ? "ppt"
            : ext === "mp4"
              ? "mp4"
              : "stream";
  return { image: false, fileType };
}

/** Files as links into witden; technical failures are only recorded in console diagnostics. */
export function fileLinks(files: Artifact[]): string {
  const lines = files.map(
    (f) => `${f.mime.startsWith("image/") ? "🖼" : "📎"} [${f.name}](${consoleBase()}/api/files/${f.id})`,
  );
  return lines.join("\n\n");
}

/** An image or file in a received message, to download with ``fetchFile``. */
export interface FeishuInFile {
  message_id: string;
  key: string;
  /** Feishu's resource type: images (also those in posts) or files (files, audio, video). */
  type: "image" | "file";
  name: string;
  mimetype?: string;
}

/** The images and files a received message carries. */
export function messageFiles(type: string, raw: string | undefined, messageId: string): FeishuInFile[] {
  let content: any;
  try {
    content = JSON.parse(raw ?? "{}");
  } catch {
    return [];
  }
  const image = (key: unknown, i = 0): FeishuInFile => ({
    message_id: messageId,
    key: String(key),
    type: "image",
    name: `飞书图片-${messageId.slice(-6)}${i ? `-${i + 1}` : ""}.png`,
  });
  if (type === "image" && content.image_key) return [image(content.image_key)];
  if (["file", "media", "audio"].includes(type) && content.file_key)
    return [
      {
        message_id: messageId,
        key: String(content.file_key),
        type: "file",
        name: String(content.file_name || (type === "audio" ? "语音.opus" : type === "media" ? "视频.mp4" : "文件")),
      },
    ];
  if (type === "post") {
    const post = Array.isArray(content.content)
      ? content
      : (Object.values(content).find((v: any) => v?.content) as any);
    const keys: string[] = [];
    for (const paragraph of post?.content ?? [])
      for (const el of Array.isArray(paragraph) ? paragraph : [])
        if (el?.tag === "img" && el.image_key) keys.push(el.image_key);
    return keys.map((k, i) => image(k, i));
  }
  return [];
}

/** The extension for an image Feishu sends back (its Content-Type). */
export function imageExtension(mime: string): string {
  const sub = /^image\/([a-z0-9.+-]+)/.exec(mime)?.[1] ?? "png";
  return sub === "jpeg" ? "jpg" : sub.replace(/^x-/, "").replace("vnd.microsoft.icon", "ico");
}
