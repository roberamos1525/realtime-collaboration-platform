/**
 * Extracts `@username` mentions from free text. A mention must start at the
 * beginning of the text or after a character that cannot be part of a
 * username (so e-mail addresses are not treated as mentions).
 */
const MENTION = /(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,30}[A-Za-z0-9_])?)/g;

export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const name = match[2];
    if (name) found.add(name.toLowerCase());
  }
  return [...found];
}

/** Username rules shared by registration validation and mention parsing. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{1,30}[A-Za-z0-9_])$/;

/** Truncates text for previews, appending an ellipsis when shortened. */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
