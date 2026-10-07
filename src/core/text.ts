/** Document text truncation (document cap and per-tool response budgets). */

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/**
 * Cuts `text` to at most `maxChars`, preferring the last paragraph boundary (blank line), then a line
 * break, then whitespace, then a hard cut. `truncated` is true whenever anything was removed.
 */
export function truncateText(text: string, maxChars: number): TruncatedText {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= 0) return { text: "", truncated: true };

  const cutAt = (index: number): TruncatedText => ({ text: text.slice(0, index).trimEnd(), truncated: true });

  const paragraph = text.lastIndexOf("\n\n", maxChars);
  if (paragraph > 0) return cutAt(paragraph);
  const line = text.lastIndexOf("\n", maxChars);
  if (line > 0) return cutAt(line);
  for (let i = maxChars; i > 0; i--) {
    if (/\s/.test(text.charAt(i))) return cutAt(i);
  }
  return { text: text.slice(0, maxChars), truncated: true };
}
