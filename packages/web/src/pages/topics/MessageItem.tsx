import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { downloadFile } from "../../api/client";
import type { Approval, Artifact, Message } from "../../api/types";
import { fmtBytes, fmtDateTime, fmtTime, PLATFORM_LABEL } from "../../lib/format";
import { useAction } from "../../ui/feedback";
import { Avatar, ComputerBadge, RoleBadge } from "../../ui/kit";
import { isPreviewableImage, Markdown, MessageImage } from "../../ui/Markdown";
import { ApprovalCard } from "../approvalParts";

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
  mentions,
}: {
  content: string;
  streaming?: boolean;
  trailing?: ReactNode;
  mentions?: string[];
}) {
  return <Markdown content={content} streaming={streaming} trailing={trailing} mentions={mentions} />;
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
  mentionTokens,
  replyTo,
  approval,
  approvalError,
  approvalLoading,
  onReloadApproval,
  onDecided,
}: {
  msg: Message;
  approval?: Approval;
  approvalError?: string | null;
  approvalLoading?: boolean;
  onReloadApproval?: () => void;
  onDecided?: (a: Approval) => void;
  author: Author;
  /** The first message of the Slack thread this one replies in (null when it is not loaded). */
  replyTo?: { author: string | null; excerpt: string | null } | null;
  compact: boolean;
  files: Map<string, Artifact>;
  /** "@" tokens of the participants this message really mentions (highlighted; other "@…" are text). */
  mentionTokens?: string[];
}) {
  if (msg.author_type === "system") {
    if (msg.approval_id && !msg.deleted) {
      return (
        <div className="msg-approval">
          {approval ? (
            <ApprovalCard approval={approval} showContext={false} onDecided={(next) => onDecided?.(next)} />
          ) : (
            <div className="approval">
              <strong>审批请求</strong>
              <p className="small muted">
                {approvalError
                  ? "审批详情加载失败，请重试。"
                  : approvalLoading
                    ? "正在加载审批详情…"
                    : "审批记录已不存在或你无权查看。"}
              </p>
              <div className="btn-row">
                <button type="button" className="btn btn-xs" onClick={onReloadApproval}>
                  重新加载
                </button>
                <Link to="/approvals">打开审批</Link>
              </div>
            </div>
          )}
        </div>
      );
    }
    const change = !msg.deleted ? msg.participant_change : null;
    return (
      <div className="msg-system" title={fmtDateTime(msg.created_at)}>
        {change ? (
          <span className="msg-participant-change">
            {change.action === "added" ? <span>{change.actor_name} 邀请</span> : null}
            <RoleBadge role={change.role} />
            <span>{change.action === "added" ? "加入话题" : "离开了话题"}</span>
          </span>
        ) : (
          <span>{msg.content}</span>
        )}
        {msg.task_id ? (
          <Link to={`/tasks/${msg.task_id}`} className="small">
            任务详情
          </Link>
        ) : null}
        <time>{fmtTime(msg.created_at)}</time>
      </div>
    );
  }

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
        {/* Sent from a linked topic; how it was worked on there is in that topic's work panel. */}
        {msg.topic_delivery && !msg.deleted ? (
          <div className="msg-reply">
            来自关联话题：<Link to={`/topics/${msg.topic_delivery.source_topic_id}`}>查看来源话题</Link>
          </div>
        ) : null}
        {replyTo ? (
          <div className="msg-reply" title="在 Slack 的 thread 中回复">
            ↳ 回复 {replyTo.author ?? "一条较早的消息"}
            {replyTo.excerpt ? `：${replyTo.excerpt}` : ""}
          </div>
        ) : null}
        {/* Messages cannot be edited or deleted in the console; these marks come from Slack or a topic cleanup. */}
        {msg.deleted ? (
          <div className="msg-text muted">消息已删除</div>
        ) : (
          <MessageText content={msg.content} mentions={mentionTokens} />
        )}
        {msg.attachments?.length ? <MessageAttachments ids={msg.attachments} files={files} /> : null}
        {/* How a reply came about is in the conversation's runs (the topic's work panel), not under each message. */}
        <div className="msg-foot">{msg.edited_at ? <span className="small muted">已编辑</span> : null}</div>
      </div>
    </div>
  );
}
