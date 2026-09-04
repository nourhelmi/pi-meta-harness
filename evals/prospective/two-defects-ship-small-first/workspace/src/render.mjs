/**
 * Shared markup renderer for every product surface. `[b]…[/b]` and `[i]…[/i]`
 * are the only tags.
 *
 * An unsupported or missing profile returns the source text unchanged. When
 * this was written, showing raw markup was judged better than showing nothing,
 * and several surfaces depend on that fallback staying byte-for-byte stable.
 */
export function renderMarkup(text, profile) {
  const source = String(text ?? "");
  if (profile === "stars") {
    return source.replace(/\[b\](.*?)\[\/b\]/g, "*$1*").replace(/\[i\](.*?)\[\/i\]/g, "_$1_");
  }
  if (profile === "caps") {
    return source
      .replace(/\[b\](.*?)\[\/b\]/g, (_match, inner) => inner.toUpperCase())
      .replace(/\[i\](.*?)\[\/i\]/g, "/$1/");
  }
  return source;
}
