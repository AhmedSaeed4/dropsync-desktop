/**
 * useMentionEditor — desktop port of the web hook, drop-picker only (the @member machinery is
 * stripped: a local vault has no members). Backs a contentEditable editor that renders
 * #[Name](id) tokens as inline atomic chips while typing, but keeps the SAVED value as the
 * plain token string so encrypt/save round-trips are unchanged.
 *
 * Caret-safety contract (verbatim from the web): the browser owns the DOM during typing — we
 * only READ DOM → serialize → setContent. innerHTML is written ONLY when `content` diverges
 * from what the DOM last produced (mount / edit-load / external append).
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { KeyboardEvent, FocusEvent, Dispatch, SetStateAction } from 'react';
import type { Drop } from '../lib/types';
import { detectHashtagTrigger, parseMessageContent } from '../lib/dropTagUtils';

// Zero-width space placed after each chip so the caret has a landing spot; stripped on serialize.
const ZWSP = '\u200B';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// DOM → token string. Walks child nodes; chips collapse back to #[Name](id), <br>/blocks → \n.
function serializeNode(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child.textContent || '').replace(/\u200B/g, '').replace(/\u00A0/g, ' ');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.classList && el.classList.contains('mention-chip')) {
        const name = el.getAttribute('data-chip-name') || '';
        const id = el.getAttribute('data-chip-id') || '';
        out += `#[${name}](${id})`;
      } else if (el.tagName === 'BR') {
        out += '\n';
      } else if (el.tagName === 'DIV' || el.tagName === 'P') {
        if (out.length > 0 && !out.endsWith('\n')) out += '\n';
        out += serializeNode(el);
      } else {
        out += serializeNode(el);
      }
    }
  });
  return out;
}

// Token string → HTML for initial render / external updates. Chips are contenteditable=false;
// unresolved ids render with the deleted style (web parity — chip remains, never crashes).
function renderContentToHtml(
  content: string,
  allDrops: Drop[],
  foundClassName: string,
  deletedClassName: string,
): string {
  return parseMessageContent(content).map((part) => {
    if (part.type === 'text') {
      return escapeHtml(part.value || '').replace(/\n/g, '<br>');
    }
    const name = part.name || '';
    const id = part.dropId || '';
    const exists = allDrops.some((d) => d.id === id);
    const cls = exists ? foundClassName : deletedClassName;
    return `<span class="mention-chip ${cls}" contenteditable="false" data-chip-kind="drop" data-chip-name="${escapeHtml(name)}" data-chip-id="${escapeHtml(id)}">${escapeHtml(name)}</span>${ZWSP}`;
  }).join('');
}

function createChipElement(drop: Drop, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `mention-chip ${className}`;
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('data-chip-kind', 'drop');
  span.setAttribute('data-chip-name', drop.name);
  span.setAttribute('data-chip-id', drop.id);
  span.textContent = drop.name;
  return span;
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false); // end
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

export interface UseMentionEditorOptions {
  content: string;
  setContent: Dispatch<SetStateAction<string>>;
  allDrops: Drop[];
  /** Drop id to exclude from the picker (the drop being edited can't mention itself). */
  excludeDropId?: string;
  foundClassName: string;
  deletedClassName: string;
}

export function useMentionEditor({
  content,
  setContent,
  allDrops,
  excludeDropId,
  foundClassName,
  deletedClassName,
}: UseMentionEditorOptions) {
  const editorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // The last string either read FROM or written INTO the DOM — caret-safety guard.
  const lastSerializedRef = useRef<string | null>(null);
  // The text node + offset of the active #query, captured on input for insertMention.
  const mentionTextNodeRef = useRef<Text | null>(null);
  const mentionStartOffsetRef = useRef<number>(0);

  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  // Bumped when the contentEditable remounts so the external→DOM sync re-runs even if `content`
  // is unchanged (edit A → edit B with identical text would otherwise stay blank).
  const [mountKey, setMountKey] = useState(0);
  const setEditorRef = useCallback((node: HTMLDivElement | null) => {
    editorRef.current = node;
    if (node) {
      lastSerializedRef.current = null;
      setMountKey((k) => k + 1);
    }
  }, []);

  const filteredMentionDrops = useMemo(() => {
    const q = mentionQuery.toLowerCase().trim();
    let list = allDrops.filter((d) => d.id !== excludeDropId);
    if (q) list = list.filter((d) => d.name.toLowerCase().includes(q));
    const MAX_RESULTS = typeof window !== 'undefined' && window.innerWidth < 640 ? 5 : 8;
    return list.slice(0, MAX_RESULTS);
  }, [allDrops, mentionQuery, excludeDropId]);

  useEffect(() => { setMentionIndex(0); }, [mentionQuery]);

  useEffect(() => {
    setMentionIndex((idx) => Math.max(0, Math.min(idx, filteredMentionDrops.length - 1)));
  }, [filteredMentionDrops]);

  useEffect(() => {
    if (!showMention) return;
    const el = dropdownRef.current?.querySelector('[data-drop-highlighted="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex, showMention]);

  // EXTERNAL → DOM. Never fires mid-typing (the guard sees content === lastSerialized).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (lastSerializedRef.current && editor.childNodes.length === 0) {
      lastSerializedRef.current = null;
    }
    if (content !== lastSerializedRef.current) {
      editor.innerHTML = renderContentToHtml(content, allDrops, foundClassName, deletedClassName);
      lastSerializedRef.current = content;
      placeCaretAtEnd(editor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, mountKey]);

  // DOM → EXTERNAL. Read-only on input.
  const handleInput = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const serialized = serializeNode(editor);
    lastSerializedRef.current = serialized;
    setContent(serialized);

    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (sel && sel.rangeCount && node && editor.contains(node) && node.nodeType === Node.TEXT_NODE) {
      const textBefore = (node.textContent || '').slice(0, sel.anchorOffset);
      const hashTrigger = detectHashtagTrigger(textBefore);
      if (hashTrigger && hashTrigger.query.length >= 0) {
        setShowMention(true);
        setMentionQuery(hashTrigger.query);
        mentionTextNodeRef.current = node as Text;
        mentionStartOffsetRef.current = hashTrigger.startIndex;
        return;
      }
    }
    setShowMention(false);
    setMentionQuery('');
    mentionTextNodeRef.current = null;
  };

  const insertMention = (drop: Drop) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    const chip = createChipElement(drop, foundClassName);
    const zwsp = document.createTextNode(ZWSP);

    const node = mentionTextNodeRef.current;
    if (node && editor.contains(node) && node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      const start = Math.min(mentionStartOffsetRef.current, len);
      let end = sel && sel.anchorNode === node ? sel.anchorOffset : len;
      end = Math.max(start, Math.min(end, len));
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      range.deleteContents();
      range.insertNode(zwsp);
      zwsp.parentNode?.insertBefore(chip, zwsp);
    } else {
      if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(zwsp);
        zwsp.parentNode?.insertBefore(chip, zwsp);
      } else {
        editor.appendChild(chip);
        editor.appendChild(zwsp);
      }
    }

    const newRange = document.createRange();
    newRange.setStartAfter(zwsp);
    newRange.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(newRange);

    const serialized = serializeNode(editor);
    lastSerializedRef.current = serialized;
    setContent(serialized);

    setShowMention(false);
    setMentionQuery('');
    setMentionIndex(0);
    mentionTextNodeRef.current = null;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (showMention && filteredMentionDrops.length > 0) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((p) => Math.max(0, p - 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((p) => Math.min(filteredMentionDrops.length - 1, p + 1)); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const sel = filteredMentionDrops[mentionIndex]; if (sel) insertMention(sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowMention(false); return; }
    }
  };

  const handleBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (dropdownRef.current?.contains(e.relatedTarget as Node)) return;
    setShowMention(false);
  };

  const focusEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    placeCaretAtEnd(editor);
  };

  return {
    editorRef,
    setEditorRef,
    dropdownRef,
    showMention,
    mentionQuery,
    mentionIndex,
    setMentionIndex,
    filteredMentionDrops,
    handleInput,
    handleKeyDown,
    handleBlur,
    insertMention,
    focusEditor,
  };
}
