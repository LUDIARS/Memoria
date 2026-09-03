// 書誌の正規化。 ISBN と 「タイトルキー」 の作り方をここ 1 か所に閉じる。
//
// 同じ本が Google Books / openBD / NDL / 楽天 から少しずつ違う表記で来るので、
// 所持判定・重複排除はすべて title_key で行う。

/** 全角英数字・カタカナ長音などを畳んで比較用の文字列にする。 */
function foldWidth(value: string): string {
  return value.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/** 出版形態だけを表す括弧注記を落とし、題名・副題の括弧は保持する。 */
function stripEditionAnnotations(value: string): string {
  return value.replace(/[（(\[【]([^）)\]】]*)[）)\]】]/g, (whole: string, annotation: string) => (
    /(?:文庫|新書|コミックス?|単行本|電子書籍|kindle(?:版)?|新装版|改訂版|増補版|完全版|愛蔵版|普及版|廉価版|新版)版?\s*$/i
      .test(annotation)
      ? ' '
      : whole
  ));
}

/**
 * 比較用タイトルキー。 巻数は残す (1 巻と 2 巻は別の本)。
 * 落とすのは装飾だけ — 括弧書きのレーベル表記、 記号、 空白、 大文字小文字。
 */
export function titleKey(title: string): string {
  return stripEditionAnnotations(foldWidth(title))
    .toLowerCase()
    .replace(/[\s\u30FB･・:：;；,，、。.!！?？'"“”‘’\-—―_/\|~〜]/g, '')
    .trim();
}

/** ハイフン等を除いた ISBN。 10 桁は 13 桁へ変換する。 変換できなければ null。 */
export function normalizeIsbn13(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 13 && /^\d{13}$/.test(digits)) return digits;
  if (digits.length !== 10) return null;
  const core = `978${digits.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

/** `2026-09-03` / `2026-09` / `2026` / `20260903` / `2026年9月3日` を YYYY-MM-DD 寄りに寄せる。 */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = foldWidth(String(raw)).trim();
  const kanji = text.match(/^(\d{4})年(?:\s*(\d{1,2})月)?(?:\s*(\d{1,2})日)?\s*$/);
  if (kanji) return joinDate(kanji[1], kanji[2], kanji[3]);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return joinDate(compact[1], compact[2], compact[3]);
  const iso = text.match(/^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/);
  if (iso) return joinDate(iso[1], iso[2], iso[3]);
  return null;
}

function joinDate(y: string, m?: string, d?: string): string | null {
  const year = Number(y);
  if (year < 1000) return null;
  if (!m) return y;
  const month = Number(m);
  if (month < 1 || month > 12) return null;
  const mm = m.padStart(2, '0');
  if (!d) return `${y}-${mm}`;
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${y}-${mm}-${d.padStart(2, '0')}`;
}

/** 日付を比較用の日 (欠けた月日は月初扱い) にする。 パースできなければ null。 */
export function dateFloor(raw: string | null): Date | null {
  const normalized = normalizeDate(raw);
  if (!normalized) return null;
  const [y, m, d] = normalized.split('-');
  const date = new Date(Number(y), m ? Number(m) - 1 : 0, d ? Number(d) : 1);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「著者名／著」 「山田 太郎, 訳」 のような NDL 表記から人名だけ取り出す。 */
export function cleanAuthor(raw: string): string {
  return foldWidth(raw)
    .replace(/[／/]\s*(著|訳|編|監修|作|画|イラスト|原作)\s*$/g, '')
    .replace(/[,、]\s*(著|訳|編|監修|作|画|イラスト|原作)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanAuthors(raw: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (!entry) continue;
    for (const part of String(entry).split(/[;；]/)) {
      const name = cleanAuthor(part);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * シリーズ名の推定。 「よくわかる指標 3」 → 「よくわかる指標」。
 * 巻数の付かないタイトルは null (シリーズ扱いしない)。
 */
export function guessSeries(title: string): string | null {
  const text = foldWidth(title).trim();
  const match = text.match(/^(.{2,}?)\s*(?:第?\s*\d{1,3}\s*(?:巻|集)?|\(\d{1,3}\)|［\d{1,3}］)\s*$/);
  if (!match) return null;
  const base = match[1].replace(/[\s:：・-]+$/, '').trim();
  return base.length >= 2 ? base : null;
}
