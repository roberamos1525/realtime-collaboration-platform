import type { PresencePeer } from "@rcp/shared";
import { forwardRef, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { buildOverlay, withAlpha, type Caret, type Highlight } from "../lib/overlay";
import type { DocumentSync, Selection } from "../lib/doc-sync";

export interface CommentRange {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly active: boolean;
}

export interface EditorHandle {
  /** Replaces the textarea content after a remote change. */
  setText(text: string, selection: Selection | null): void;
  focusRange(start: number, end: number): void;
  selection(): Selection | null;
}

interface Props {
  readonly sync: DocumentSync;
  readonly text: string;
  readonly peers: readonly PresencePeer[];
  readonly comments: readonly CommentRange[];
  readonly readOnly: boolean;
  readonly onLocalChange: (text: string) => void;
  readonly onSelection: (selection: Selection | null) => void;
}

/**
 * Plain-text collaborative editor. A transparent textarea handles input
 * while an overlay rendered underneath with identical typography shows
 * remote selections, remote carets (with name labels) and comment ranges.
 */
function EditorImpl({ sync, text, peers, comments, readOnly, onLocalChange, onSelection }: Props, ref: Ref<EditorHandle>) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    setText(next, selection) {
      const ta = textarea.current;
      if (!ta) return;
      const focused = document.activeElement === ta;
      const scroll = ta.scrollTop;
      if (ta.value !== next) ta.value = next;
      if (selection && focused) ta.setSelectionRange(selection.start, selection.end);
      ta.scrollTop = scroll;
    },
    focusRange(start, end) {
      const ta = textarea.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(start, end);
    },
    selection() {
      const ta = textarea.current;
      return ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
    },
  }));

  const pieces = useMemo(() => {
    const highlights: Highlight[] = [];
    const carets: Caret[] = [];
    for (const c of comments) {
      highlights.push({ id: `c:${c.id}`, from: c.start, to: c.end, color: "#ffb224", kind: c.active ? "active-comment" : "comment" });
    }
    for (const peer of peers) {
      const sel = sync.resolveCursor(peer.cursor);
      if (!sel) continue;
      if (sel.end > sel.start) highlights.push({ id: `p:${peer.connectionId}`, from: sel.start, to: sel.end, color: peer.color, kind: "selection" });
      const headIndex = sync.resolvePosition(peer.cursor?.head ?? null) ?? sel.end;
      carets.push({ id: peer.connectionId, at: headIndex, color: peer.color, label: peer.displayName });
    }
    return buildOverlay(text, highlights, carets);
    // `text` changes whenever the replica changes, which is what positions depend on.
  }, [sync, text, peers, comments]);

  const reportSelection = () => {
    const ta = textarea.current;
    if (ta) onSelection({ start: ta.selectionStart, end: ta.selectionEnd });
  };

  return (
    <div className="editor">
      <div className="editor-overlay" ref={overlay} aria-hidden="true">
        {pieces.map((p, i) =>
          p.kind === "caret" ? (
            <span key={`caret-${p.caret.id}`} className="remote-caret" style={{ borderColor: p.caret.color }}>
              <span className="remote-caret-label" style={{ background: p.caret.color }}>
                {p.caret.label}
              </span>
            </span>
          ) : p.highlights.length === 0 ? (
            <span key={i}>{p.text}</span>
          ) : (
            <mark
              key={i}
              className={p.highlights.map((h) => `hl-${h.kind}`).join(" ")}
              style={{ background: withAlpha(p.highlights[p.highlights.length - 1]?.color ?? "#ffb224", p.highlights.some((h) => h.kind === "active-comment") ? 0.45 : 0.25) }}
            >
              {p.text}
            </mark>
          ),
        )}
        {"​"}
      </div>
      <textarea
        ref={textarea}
        className="editor-input"
        defaultValue={text}
        readOnly={readOnly}
        spellCheck
        aria-label="Document text"
        placeholder={readOnly ? "This document is empty." : "Start writing…"}
        onInput={(e) => {
          const ta = e.currentTarget;
          if (!sync.applyLocalText(ta.value, ta.selectionStart)) {
            ta.value = sync.text;
            return;
          }
          onLocalChange(sync.text);
          reportSelection();
        }}
        onSelect={reportSelection}
        onKeyUp={reportSelection}
        onMouseUp={reportSelection}
        onBlur={() => onSelection(null)}
        onScroll={(e) => {
          if (overlay.current) overlay.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}

export const CollaborativeEditor = forwardRef(EditorImpl);
