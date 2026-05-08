// Sanitize HTML inside note text blocks.
//
// 許可するインライン要素:
//   <b> <strong> <i> <em> <u> <code> <a href> <span style="color: #...">
// 許可する block-level (heading / quote 内に許す):
//   <br>
//
// それ以外は textContent を残してタグだけ削る (= flatten)。

const INLINE_ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'CODE', 'A', 'SPAN', 'BR']);
const COLOR_RE = /color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([0-9, ]+\)|[a-zA-Z]+)/;

export function sanitizeInlineHtml(input: string): string {
  if (!input) return '';
  // Use DOMParser to walk the tree.
  const tpl = document.createElement('template');
  tpl.innerHTML = input;
  walk(tpl.content);
  return tpl.innerHTML;
}

function walk(node: ParentNode): void {
  const children = [...node.childNodes];
  for (const ch of children) {
    if (ch.nodeType === Node.TEXT_NODE) continue;
    if (ch.nodeType !== Node.ELEMENT_NODE) {
      ch.parentNode?.removeChild(ch);
      continue;
    }
    const el = ch as HTMLElement;
    const tag = el.tagName;
    if (!INLINE_ALLOWED_TAGS.has(tag)) {
      // unwrap: replace element with its children
      const frag = document.createDocumentFragment();
      while (el.firstChild) frag.appendChild(el.firstChild);
      el.replaceWith(frag);
      continue;
    }
    // sanitize attributes
    if (tag === 'A') {
      const href = el.getAttribute('href') || '';
      // allow http(s):// and mailto:
      if (!/^(https?:|mailto:|\/|#)/i.test(href)) {
        el.removeAttribute('href');
      } else {
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
      // strip dangerous attrs
      stripAttrsExcept(el, ['href', 'rel', 'target']);
    } else if (tag === 'SPAN') {
      const style = el.getAttribute('style') || '';
      const m = COLOR_RE.exec(style);
      if (m) {
        el.setAttribute('style', `color: ${m[1]}`);
      } else {
        // 色指定がない span は剥がす (= unwrap)
        const frag = document.createDocumentFragment();
        while (el.firstChild) frag.appendChild(el.firstChild);
        el.replaceWith(frag);
        continue;
      }
      stripAttrsExcept(el, ['style']);
    } else {
      // b/strong/i/em/u/code/br
      stripAttrsExcept(el, []);
    }
    walk(el);
  }
}

function stripAttrsExcept(el: HTMLElement, keep: string[]): void {
  const keepSet = new Set(keep);
  const names = [...el.attributes].map((a) => a.name);
  for (const n of names) {
    if (!keepSet.has(n)) el.removeAttribute(n);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
