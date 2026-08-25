/** Mention-chip parsing — verbatim port of the web's lib/dropTagUtils.ts pure halves. */

export const DROP_TAG_REGEX = /#\[([^\]]+)\]\(([^)]+)\)/g;
export const USER_TAG_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g;

const ANY_TAG_REGEX = /(#\[([^\]]+)\]\(([^)]+)\))|(@\[([^\]]+)\]\(([^)]+)\))/g;

export interface ParsedPart {
  type: 'text' | 'tag';
  value?: string;
  name?: string;
  dropId?: string;
  uid?: string;
}

export function parseMessageContent(content: string): ParsedPart[] {
  const parts: ParsedPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  ANY_TAG_REGEX.lastIndex = 0;

  while ((match = ANY_TAG_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined) {
      parts.push({ type: 'tag', name: match[2], dropId: match[3] });
    } else {
      parts.push({ type: 'tag', name: match[5], uid: match[6] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts;
}

export function contentToPlainText(content: string): string {
  return parseMessageContent(content)
    .map(p => (p.type === 'text' ? p.value : p.name) ?? '')
    .join('')
    .replace(/\u00A0/g, ' ');
}

// ---- mention trigger detection (web parity; desktop only uses the # drop picker) ----

export const HASHTAG_TRIGGER_REGEX = /(?:^|[\s\n])#(\S*)$/;

export function detectHashtagTrigger(textBeforeCursor: string): { query: string; startIndex: number } | null {
  const match = textBeforeCursor.match(HASHTAG_TRIGGER_REGEX);
  if (!match) return null;
  const hashIndex = match[0].startsWith('#') ? match.index! : match.index! + 1;
  return { query: match[1], startIndex: hashIndex };
}
