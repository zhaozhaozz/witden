import { type ChangeEvent, type KeyboardEvent, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { Artifact, Mention, Participant, PostMessageResult } from "../../api/types";
import { fmtBytes } from "../../lib/format";
import { useAuth } from "../../lib/session";
import { useFeedback } from "../../ui/feedback";
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
 * Message composer. `@` opens an autocomplete over topic participants; on send, every `@token`
 * that matches a participant is sent as a structured mention so routing does not depend on text parsing.
 */
export function Composer({
  topicId,
  participants,
  onSent,
}: {
  topicId: string;
  participants: Participant[];
  onSent: (msg: PostMessageResult) => void;
}) {
  const { me } = useAuth();
  const { toast } = useFeedback();
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
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
    setQuery(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(before.length, before.length);
      }
    });
  };

  const structuredMentions = (content: string): Mention[] | undefined => {
    const found: Mention[] = [];
    const seen = new Set<string>();
    for (const m of content.matchAll(/@([^\s@，。,.!?！？:：;；()（）]+)/g)) {
      const token = m[1].toLowerCase();
      const c = candidates.find((x) => x.token.toLowerCase() === token);
      if (c && !seen.has(`${c.type}:${c.id}`)) {
        seen.add(`${c.type}:${c.id}`);
        found.push({ type: c.type, id: c.id });
      }
    }
    return found.length ? found : undefined;
  };

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
          placeholder="输入消息，用 @ 提及角色或成员。Enter 发送，Shift+Enter 换行"
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
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => fileInput.current?.click()}>
            附件
          </button>
          <button
            className="btn btn-sm btn-primary"
            type="button"
            disabled={sending || uploading > 0 || (!text.trim() && !pending.length)}
            onClick={() => void send()}
          >
            {sending ? "发送中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
