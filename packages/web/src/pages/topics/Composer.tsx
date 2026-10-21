import { type ChangeEvent, type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { Artifact, Mention, Participant, PostMessageResult } from "../../api/types";
import { fmtBytes } from "../../lib/format";
import { useAuth } from "../../lib/session";
import { useFeedback } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Avatar, ComputerBadge } from "../../ui/kit";

interface Candidate {
  type: "role" | "user";
  id: string;
  name: string;
  /** Text inserted after "@" */
  token: string;
  handle?: string | null;
  avatarUrl?: string | null;
  color?: string | null;
  computer?: { id: string; name: string; color: string | null } | null;
}

// "@query" right before the caret, at the start of input or after whitespace / opening bracket.
const TRIGGER = /(^|[\s(（,，])@([^\s@]*)$/;

function tokenFor(p: Participant): string {
  return p.type === "role" ? (p.handle ?? p.name) : p.name.replace(/\s+/g, "");
}

/**
 * Message composer. `@` opens an autocomplete over topic participants. Only people and roles picked from
 * that list are mentions: they are sent as a structured list (empty when nobody was picked), so an "@name"
 * that was pasted or typed is just text and never starts work.
 */
export function Composer({
  topicId,
  participants,
  onSent,
  placeholder = "描述你想完成的工作，输入 @ 选择 AI 员工…",
  hint = "@ 后从列表选择，才会通知对应 AI 员工",
}: {
  topicId: string;
  participants: Participant[];
  onSent: (msg: PostMessageResult) => void;
  placeholder?: string;
  hint?: string;
}) {
  const { me } = useAuth();
  const { toast } = useFeedback();
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  // Picked from the autocomplete; a pick counts only while its "@token" is still in the text.
  const [picked, setPicked] = useState<Candidate[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes after a pick; applied right after the text renders, before the next keystroke.
  const caretAfterPick = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const candidates: Candidate[] = useMemo(
    () =>
      participants
        .filter((p) => !(p.type === "user" && p.id === me?.id))
        .map((p) => ({
          type: p.type,
          id: p.id,
          name: p.name,
          token: tokenFor(p),
          handle: p.handle,
          avatarUrl: p.avatar_url,
          color: p.color,
          computer: p.instance,
        })),
    [participants, me?.id],
  );

  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return candidates
      .filter((c) => !q || c.token.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
      .sort((a, b) => (a.type === b.type ? 0 : a.type === "role" ? -1 : 1))
      .slice(0, 8);
  }, [candidates, query]);

  const syncQuery = (value: string, caret: number) => {
    const m = TRIGGER.exec(value.slice(0, caret));
    setQuery(m ? m[2] : null);
    setActive(0);
  };

  const pick = (c: Candidate) => {
    const el = area.current;
    const caret = el ? el.selectionStart : text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${c.token} `);
    const next = before + text.slice(caret);
    setText(next);
    setPicked((p) => (p.some((x) => x.type === c.type && x.id === c.id) ? p : [...p, c]));
    setQuery(null);
    caretAfterPick.current = before.length;
  };

  useLayoutEffect(() => {
    const el = area.current;
    const at = caretAfterPick.current;
    if (!el || at === null) return;
    caretAfterPick.current = null;
    el.focus();
    el.setSelectionRange(at, at);
  }, [text]);

  const structuredMentions = (content: string): Mention[] =>
    picked.filter((c) => content.includes(`@${c.token}`)).map((c) => ({ type: c.type, id: c.id }));

  const send = async () => {
    const content = text.trim();
    if ((!content && !pending.length) || sending || uploading) return;
    setSending(true);
    try {
      const msg = await api.post<PostMessageResult>(`/api/topics/${topicId}/messages`, {
        content,
        mentions: structuredMentions(content),
        attachments: pending.map((a) => a.id),
      });
      setText("");
      setPicked([]);
      setPending([]);
      onSent(msg);
    } catch (err) {
      toast(errorMessage(err), "bad");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never act while an input method is composing (Chinese input confirms candidates with Enter).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (query !== null && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append("file", file);
        const art = await api.upload<Artifact>(`/api/topics/${topicId}/files`, form);
        setPending((p) => [...p, art]);
      } catch (err) {
        toast(`${file.name}：${errorMessage(err)}`, "bad");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const removePending = async (art: Artifact) => {
    setPending((p) => p.filter((x) => x.id !== art.id));
    try {
      await api.del(`/api/files/${art.id}`);
    } catch {
      // the file stays in the topic's file list; nothing else to do
    }
  };

  return (
    <div className="composer">
      {query !== null && matches.length ? (
        <ul className="mention-pop" role="listbox">
          {matches.map((c, i) => (
            <li
              key={`${c.type}:${c.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "mention-opt mention-on" : "mention-opt"}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <Avatar id={c.id} name={c.name} kind={c.type} size={22} src={c.avatarUrl} color={c.color} />
              <span>{c.name}</span>
              <span className="muted small">{c.type === "role" ? `@${c.handle}` : "成员"}</span>
              {c.computer ? <ComputerBadge computer={c.computer} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {pending.length || uploading ? (
        <div className="composer-files">
          {pending.map((a) => (
            <span key={a.id} className="attach attach-pending">
              <span className="attach-name">{a.name}</span>
              <span className="attach-size">{fmtBytes(a.size)}</span>
              <button type="button" className="icon-btn" aria-label="移除附件" onClick={() => void removePending(a)}>
                ×
              </button>
            </span>
          ))}
          {uploading ? <span className="small muted">正在上传 {uploading} 个文件…</span> : null}
        </div>
      ) : null}
      <div className="composer-box">
        <textarea
          ref={area}
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          value={text}
          aria-label="消息"
          aria-describedby={`composer-hint-${topicId}`}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            syncQuery(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => syncQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => setQuery(null), 120)}
        />
        <div className="composer-actions">
          <input ref={fileInput} type="file" multiple hidden onChange={onFiles} />
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            title="从你自己的电脑选择文件，上传到这个话题"
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="attach" size={16} />
            附件
          </button>
          <span className="composer-format">支持 Markdown · 可上传文件</span>
          <button
            className="btn btn-primary composer-send"
            type="button"
            aria-label={sending ? "发送中" : "发送"}
            title="发送消息"
            disabled={sending || uploading > 0 || (!text.trim() && !pending.length)}
            onClick={() => void send()}
          >
            {sending ? <span className="spinner" aria-hidden /> : <Icon name="send" size={18} />}
          </button>
        </div>
      </div>
      <div className="composer-hint" id={`composer-hint-${topicId}`}>
        <span>{hint}</span>
        <span>Enter 发送 · Shift+Enter 换行</span>
      </div>
    </div>
  );
}
