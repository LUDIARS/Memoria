// Sanitize HTML inside note text blocks.
//
// 許可するインライン要素:
//   <b> <strong> <i> <em> <u> <code> <a href> <span style="color: #...">
// 許可する block-level (heading / quote 内に許す):
//   <br>
// 特殊: inline bookmark/note mention chip は
//   <a class="memoria-mention" data-bookmark-id="N">title</a>
//   <a class="memoria-mention" data-note-uuid="...">title</a>
//   class + data-* + href を許可。
//
// それ以外は textContent を残してタグだけ削る (= flatten)。

const INLINE_ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'CODE', 'A', 'SPAN', 'BR']);
const COLOR_RE = /color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([0-9, ]+\)|[a-zA-Z]+)/;
const BG_COLOR_RE = /background-color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([0-9, ]+\)|[a-zA-Z]+)/;
const MENTION_DATA_ATTRS = ['data-bookmark-id', 'data-note-uuid'];

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
      const cls = el.getAttribute('class') || '';
      const isMention = cls.includes('memoria-mention');
      if (isMention) {
        // memoria mention chip: keep class + data-* + (任意 href + rel/target)
        const keep: string[] = ['class'];
        for (const attr of MENTION_DATA_ATTRS) {
          if (el.hasAttribute(attr)) keep.push(attr);
        }
        if (/^(https?:|mailto:|\/|#)/i.test(href)) {
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
          keep.push('href', 'rel', 'target');
        }
        // class 属性は memoria-mention とそのバリアント (-bookmark / -note) のみ残す
        const safeCls = cls
          .split(/\s+/)
          .filter((c) => /^memoria-mention(-[\w-]+)?$/.test(c))
          .join(' ');
        el.setAttribute('class', safeCls || 'memoria-mention');
        stripAttrsExcept(el, keep);
      } else {
        // 通常リンク
        if (!/^(https?:|mailto:|\/|#)/i.test(href)) {
          el.removeAttribute('href');
        } else {
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
        }
        stripAttrsExcept(el, ['href', 'rel', 'target']);
      }
    } else if (tag === 'SPAN') {
      const style = el.getAttribute('style') || '';
      const cm = COLOR_RE.exec(style);
      const bm = BG_COLOR_RE.exec(style);
      const styleParts: string[] = [];
      if (cm) styleParts.push(`color: ${cm[1]}`);
      if (bm) styleParts.push(`background-color: ${bm[1]}`);
      if (styleParts.length === 0) {
        // 色 / 背景色とも指定なしの span は剥がす (= unwrap)
        const frag = document.createDocumentFragment();
        while (el.firstChild) frag.appendChild(el.firstChild);
        el.replaceWith(frag);
        continue;
      }
      el.setAttribute('style', styleParts.join('; '));
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
