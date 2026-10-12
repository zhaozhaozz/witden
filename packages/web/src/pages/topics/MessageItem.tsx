import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { downloadFile } from "../../api/client";
import type { Artifact, Message } from "../../api/types";
import { fmtBytes, fmtDateTime, fmtTime, PLATFORM_LABEL } from "../../lib/format";
import { useAction } from "../../ui/feedback";
import { Avatar, ComputerBadge, RoleBadge } from "../../ui/kit";
import { isPreviewableImage, Markdown, MessageImage } from "../../ui/Markdown";

export interface Author {
  kind: "user" | "role" | "system" | "external";
  id: string;
  name: string;
  handle?: string | null;
  avatarUrl?: string | null;
  /** Roles: badge colour and the computer the role works on. */
  color?: string | null;
  computer?: { id: string; name: string; color?: string | null } | null;
  isMe?: boolean;
}

/**
 * Message body rendered as Markdown (see ui/Markdown). ``streaming`` marks an answer still being written;
 * ``trailing`` follows the text (its caret).
 */
export function MessageText({
  content,
  streaming,
  trailing,
}: {
  content: string;
  streaming?: boolean;
  trailing?: ReactNode;
}) {
  return <Markdown content={content} streaming={streaming} trailing={trailing} />;
}

/** Pictures are shown in the message; other files are chips that download to the reader's own computer. */
function MessageAttachments({ ids, files }: { ids: string[]; files: Map<string, Artifact> }) {
  const images = ids.filter((id) => isPreviewableImage(files.get(id)?.mime));
  const others = ids.filter((id) => !images.includes(id));
  return (
    <>
      {images.length ? (
        <div className="msg-images">
          {images.map((id) => (
            <figure key={id}>
              <MessageImage fileId={id} alt={files.get(id)?.name} />
              <figcaption>
                <AttachmentChip id={id} file={files.get(id)} />
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {others.length ? (
        <div className="msg-attachments">
          {others.map((id) => (
            <AttachmentChip key={id} id={id} file={files.get(id)} />
          ))}
        </div>
      ) : null}
    </>
  );
}

export function AttachmentChip({ file, id }: { file?: Artifact; id: string }) {
  const { run, busy } = useAction();
  return (
    <button
      type="button"
      className="attach"
      disabled={busy || !file}
      title={file ? `${file.name} · ${fmtBytes(file.size)} · 点击下载到你自己的电脑` : "文件已删除或无权查看"}
      onClick={() => file && void run(() => downloadFile(id, file.name))}
    >
      <span className="attach-icon" aria-hidden>
        ⎘
      </span>
      <span className="attach-name">{file ? file.name : "不可用的文件"}</span>
      {file ? <span className="attach-size">{fmtBytes(file.size)}</span> : null}
    </button>
  );
}

export function MessageItem({
  msg,
  author,
  compact,
  files,
  canDelete,
  onEdit,
  onDelete,
}: {
  msg: Message;
  author: Author;
  compact: boolean;
  files: Map<string, Artifact>;
  canDelete: boolean;
  onEdit: (content: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);

  if (msg.author_type === "system") {
    return (
      <div className="msg-system" title={fmtDateTime(msg.created_at)}>
        <span>{msg.content}</span>
        {msg.task_id ? (
          <Link to={`/tasks/${msg.task_id}`} className="small">
            任务详情
          </Link>
        ) : null}
        <time>{fmtTime(msg.created_at)}</time>
      </div>
    );
  }

  const canEdit = author.isMe && msg.author_type === "user" && !msg.deleted;
  // People's messages sit on the right as bubbles; roles' answers stay on the left as plain text.
  const human = author.kind === "user" || author.kind === "external";

  return (
    <div
      className={`msg msg-${author.kind}${human ? " msg-human" : ""}${compact ? " msg-compact" : ""}${author.isMe ? " msg-mine" : ""}`}
    >
      <div className="msg-gutter">
        {compact ? (
          <time className="msg-hover-time">{fmtTime(msg.created_at)}</time>
        ) : (
          <Avatar
            id={author.id}
            name={author.name}
            kind={author.kind === "role" ? "role" : "user"}
            size={32}
            src={author.avatarUrl}
            color={author.color}
          />
        )}
      </div>
      <div className="msg-main">
        {!compact ? (
          <div className="msg-head">
            {author.kind === "role" ? (
              <>
                <RoleBadge
                  role={{
                    id: author.id,
                    name: author.name,
                    handle: author.handle,
                    color: author.color,
                    avatar_url: author.avatarUrl,
                  }}
                />
                {author.computer ? <ComputerBadge computer={author.computer} /> : null}
                <span className="ai-mark">AI 员工</span>
              </>
            ) : author.isMe ? null : (
              <span className="msg-author">{author.name}</span>
            )}
            {author.kind === "external" || (msg.source && msg.source !== "web" && msg.source !== "internal") ? (
              <span className="tag">来自 {PLATFORM_LABEL[msg.source] ?? msg.source}</span>
            ) : null}
            <time title={fmtDateTime(msg.created_at)}>{fmtTime(msg.created_at)}</time>
            {msg.round > 0 ? (
              <span className="small muted" title="角色之间自动讨论的轮次">
                第 {msg.round} 轮
              </span>
            ) : null}
          </div>
        ) : null}
        {msg.deleted ? (
          <div className="msg-text muted">消息已删除</div>
        ) : editing ? (
          <div className="msg-edit">
            <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="btn-row">
              <button type="button" className="btn btn-xs" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-xs btn-primary"
                onClick={async () => {
                  if (await onEdit(draft)) setEditing(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <MessageText content={msg.content} />
        )}
        {msg.attachments?.length ? <MessageAttachments ids={msg.attachments} files={files} /> : null}
        <div className="msg-foot">
          {msg.edited_at ? <span className="small muted">已编辑</span> : null}
          {msg.task_id ? (
            <Link to={`/tasks/${msg.task_id}`} className="small">
              来自任务
            </Link>
          ) : null}
        </div>
      </div>
      {!msg.deleted && (canEdit || canDelete) ? (
        <div className="msg-actions">
          {canEdit ? (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => {
                setDraft(msg.content);
                setEditing(true);
              }}
            >
              编辑
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" className="btn btn-xs btn-ghost" onClick={onDelete}>
              删除
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
