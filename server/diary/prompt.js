// Prompt templates and prompt-building helpers for the diary generators.

import { visitEventsForDate } from '../db.js';
import { parseSqliteUtc } from './gps.js';

export const WORK_CONTENT_PROMPT = ({ dateStr, urlList, totalEvents, totalDomains }) => [
  `あなたは ${dateStr} の「作業内容」セクションを書きます。`,
  'ブラウザ閲覧履歴 (URL + 時刻) を読み、**大まかな時間帯**で何をしていたかを 1 文でまとめ、',
  'その下に主な作業を箇条書きで添えてください。細かい行動を全部書く必要はありません。',
  '',
  '出力フォーマット (markdown のみ。前置き・コードフェンス禁止):',
  '',
  '```',
  'HH:MM～HH:MM： <その時間帯に何をしていたかを 1 文>',
  '主な作業',
  '・<具体的な内容> (HH:MM頃)',
  '・<具体的な内容> (HH:MM頃)',
  '・<具体的な内容>',
  '',
  'HH:MM～HH:MM： 記録なし',
  '',
  'HH:MM～HH:MM： <次の時間帯>',
  '主な作業',
  '・<具体的な内容> (HH:MM頃)',
  '',
  'WORK_MINUTES: <整数>',
  '```',
  '',
  '時間帯のルール:',
  '- 1 ブロック = 2〜4 時間が目安。細かく刻みすぎない。',
  '- 活動が連続する時間帯はまとめる。間が 30 分以上空いたら別ブロック。',
  '- ログのない時間帯 (寝てる / PC 離れてた等と推察できる範囲) は「記録なし」と書く',
  '- 開始は最初のアクセス時刻、終了は次の活動開始 or 最終アクセス',
  '',
  '内容のルール:',
  '- 1 文目はその時間帯のテーマ (例: 「Memoria の UI 改修をしていた」)',
  '- 「主な作業」は 2〜5 個、重要度の高い順',
  '- 推測でも断定口調 (◯◯を確認)。「〜していたと推測」「〜と思われる」は不要',
  '- ドメイン名や URL を直接出さず、内容で書く',
  '- 同じ時間帯で複数テーマがあれば 1 ブロックにまとめて 1 文で言及してから箇条書き',
  '',
  '## 作業時間の見積もり (最終行に必ず WORK_MINUTES を出す)',
  '本文の最後に空行 1 つを挟んで `WORK_MINUTES: <整数>` を必ず付けてください。',
  '- 単位は「分」。整数 (例: 360)。',
  '- 各時間帯の本文を見て「実際に集中して作業していた時間」を合計してください。',
  '  単純な開始〜終了の wall clock ではなく、移動・休憩・離席・SNS 流し見等は除く。',
  '- ブラウザのタブが開きっぱなしでもアクセス記録に動きがない時間は作業していないとみなす。',
  '- 「記録なし」のブロックは 0 分。',
  '- 24 時間 (1440 分) を超えてはいけない。実態として 12 時間を超えるのは長時間集中日のみ。',
  '- 推定材料が足りない (例: 1 件しかアクセスがない) 場合は WORK_MINUTES: 0 と書く。',
  '',
  `日付: ${dateStr}`,
  `総アクセス: ${totalEvents}`,
  `ユニークドメイン: ${totalDomains}`,
  '',
  'URL 履歴 (時刻 + URL):',
  urlList,
].join('\n');

/**
 * Pull `WORK_MINUTES: <int>` off the tail of the Sonnet output and return both
 * the cleaned narrative and the parsed minutes. Sonnet is asked to put this
 * line at the very end with a blank line before it; we tolerate any trailing
 * whitespace and missing blank line. Anything outside [0, 1440] is dropped.
 */
export function extractWorkMinutes(raw) {
  if (!raw) return { content: '', workMinutes: null };
  const text = String(raw);
  // Match the last WORK_MINUTES line (case-insensitive, allow whitespace).
  const re = /^[ \t]*WORK[_ ]MINUTES[ \t]*[:：][ \t]*(\d{1,5})[ \t]*$/im;
  const matches = [...text.matchAll(new RegExp(re.source, 'gim'))];
  if (matches.length === 0) {
    return { content: text.trim(), workMinutes: null };
  }
  const last = matches[matches.length - 1];
  const minutes = Number(last[1]);
  const cleaned = text.slice(0, last.index).replace(/\s+$/, '').trim();
  // Reject implausible values rather than persisting nonsense.
  const valid = Number.isFinite(minutes) && minutes >= 0 && minutes <= 24 * 60;
  return { content: cleaned, workMinutes: valid ? minutes : null };
}

export function formatGpsBlock(metrics) {
  const g = metrics?.gps;
  if (!g || !g.points) return '(GPS 記録なし)';
  const km = (g.distance_meters / 1000).toFixed(2);
  const hourSpan = g.hours?.length
    ? `${g.hours[0]}:00〜${g.hours[g.hours.length - 1]}:00 のあいだ`
    : '';
  const bbox = g.bbox
    ? `緯度 ${g.bbox.lat[0]}〜${g.bbox.lat[1]} / 経度 ${g.bbox.lon[0]}〜${g.bbox.lon[1]}`
    : '';
  const center = g.midpoint
    ? `中心付近 (${g.midpoint.lat}, ${g.midpoint.lon})`
    : '';
  const lines = [
    `- 記録点数: ${g.points} 点 (デバイス: ${g.devices.join(', ') || '不明'})`,
    `- 概算移動距離: 約 ${km} km`,
  ];
  if (hourSpan) lines.push(`- アクティブ時間帯: ${hourSpan}`);
  if (bbox)     lines.push(`- 範囲: ${bbox}`);
  if (center)   lines.push(`- ${center}`);
  return lines.join('\n');
}

export function formatDowntimeBlock(metrics) {
  const dts = metrics?.downtimes || [];
  if (!dts.length) return '(なし)';
  return dts.map(d => {
    const from = (d.from || '').replace('T', ' ').slice(0, 19);
    const to = (d.to || '').replace('T', ' ').slice(0, 19);
    const mins = Math.round((d.duration_ms || 0) / 60_000);
    return `- ${from} 〜 ${to} (${mins} 分間 Memoria サーバ停止 → アクセスログ取得なし)`;
  }).join('\n');
}

export function formatCaloricBalanceBlock(metrics) {
  const cb = metrics?.caloric_balance;
  if (!cb) return '(ユーザプロファイル未設定 — 設定 → AI / 連携 で年齢 / 性別 / 体重 / 身長 / 活動レベルを入れてください)';
  const p = cb.profile;
  const lines = [];
  lines.push(`プロファイル: ${p.sex === 'male' ? '男性' : '女性'} / ${p.age}歳 / ${p.weight_kg}kg / ${p.height_cm}cm / 活動 ${p.activity_level}`);
  lines.push(`基礎代謝 (BMR): 約 ${cb.bmr} kcal`);
  lines.push(`適正カロリー (TDEE = BMR × 活動係数): 約 ${cb.tdee} kcal`);
  lines.push(`軌跡からの歩行消費: 約 ${cb.walking_kcal} kcal`);
  lines.push(`1 日消費 (BMR + 歩行): 約 ${cb.expenditure_total} kcal`);
  if (cb.intake != null) {
    lines.push(`摂取カロリー (食事合計): 約 ${cb.intake} kcal`);
    const diffT = cb.diff_vs_target;
    const diffE = cb.diff_vs_expenditure;
    lines.push(`摂取 - 適正: ${diffT > 0 ? '+' : ''}${diffT} kcal`);
    lines.push(`摂取 - 消費 (収支): ${diffE > 0 ? '+' : ''}${diffE} kcal (プラス = 余剰、 マイナス = 不足)`);
  } else {
    lines.push('摂取カロリー: (食事の記録なし)');
  }
  return lines.join('\n');
}

export function formatMealsBlock(metrics) {
  const meals = metrics?.meals || [];
  if (!meals.length) return '(食事の記録なし)';
  const lines = meals.map((m) => {
    const t = formatLocalHm(m.eaten_at); // localtime HH:MM (UTC ISO を local 化)
    const desc = m.description || '(未記入)';
    const cal = (typeof m.total_calories === 'number') ? `${m.total_calories} kcal` : '— kcal';
    const loc = m.location_label ? ` @ ${m.location_label}` : '';
    const adds = (m.additions || [])
      .map((a) => {
        const ac = typeof a.calories === 'number' ? ` ${a.calories}kcal` : '';
        return `＋${a.name}${ac}`;
      })
      .join(', ');
    const addsLine = adds ? ` (追加: ${adds})` : '';
    return `- ${t} ${desc} — ${cal}${loc}${addsLine}`;
  });
  const total = (typeof metrics.meals_total_calories === 'number') ? metrics.meals_total_calories : null;
  if (total != null) lines.push(`総カロリー (推定): 約 ${total} kcal`);
  const nut = metrics.meals_nutrients;
  if (nut) {
    const fmt = (k, unit) => (typeof nut[k] === 'number' && isFinite(nut[k]))
      ? `${Math.round(nut[k] * 10) / 10}${unit}` : '—';
    lines.push(`栄養素合計 (推定): P ${fmt('protein_g', 'g')} / F ${fmt('fat_g', 'g')} / C ${fmt('carbs_g', 'g')} / 食物繊維 ${fmt('fiber_g', 'g')} / 糖質 ${fmt('sugar_g', 'g')} / 塩分 ${fmt('sodium_mg', 'mg')}`);
    if (metrics.meals_pfc_label) lines.push(`PFC バランス: ${metrics.meals_pfc_label}`);
    lines.push('※ 栄養素は写真 + 食品名から AI が推定した概数。 厳密な値ではない。');
  }
  return lines.join('\n');
}

export function formatLocalHm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(11, 16);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const HIGHLIGHTS_PROMPT = ({ dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics }) => [
  `あなたは ${dateStr} の「ハイライト」セクションを書きます。`,
  '以下の情報を統合し、その日の重要なポイントを箇条書きで 3〜6 個。',
  '事実ベース。憶測や創作はしない。重要度の高い順。',
  '',
  '## 入力 1: 作業内容 (時系列)',
  workContent || '(なし)',
  '',
  '## 入力 2: 新規ブックマーク件数',
  `${bookmarkSummary.created} 件 (再訪 ${bookmarkSummary.accessed} 件)`,
  bookmarkSummary.topDomains
    ? `主なドメイン: ${bookmarkSummary.topDomains.join(', ')}`
    : '',
  '',
  '## 入力 3: GitHub commits (リポジトリごとの件数)',
  githubByRepo.repos.length
    ? githubByRepo.repos.map(r => `- ${r.repo}: ${r.count} commits`).join('\n')
    : '(なし)',
  '',
  '## 入力 4: 当日のディグ調査 (検索 + 取得した情報源)',
  (digs && digs.length > 0)
    ? digs.map(d => {
        const summary = d.summary ? `\n  ${d.summary.slice(0, 300)}` : '';
        return `- 「${d.query}」 (${d.source_count} 件のソース, ${d.status})${summary}`;
      }).join('\n')
    : '(なし)',
  '',
  '## メタ情報',
  `総アクセス: ${metrics.total_events} / アクティブ時間帯: ${metrics.active_hours.join(',')}`,
  '',
  '## 移動 (GPS 軌跡 — OwnTracks 由来、参考情報)',
  formatGpsBlock(metrics),
  '※ GPS は jitter があるため数値は概算。場所推定は座標から自然に解釈できる範囲のみ書くこと (推測しすぎない)。',
  '',
  '## サーバ停止 (5 分超のダウンタイム)',
  formatDowntimeBlock(metrics),
  '上記時間帯はアクセスログが欠落しているので、その時間帯の活動についてはデータがない旨を簡潔に注記してください。',
  '',
  '## 食事 (写真投稿 + AI 推定 / 手動補正、 参考情報)',
  formatMealsBlock(metrics),
  '※ カロリーは推定値で誤差を含む。 ハイライトに含める時は「総カロリー約 X kcal」 のような概数表記で。',
  '',
  '## カロリーバランス (適正 vs 摂取 vs 消費)',
  formatCaloricBalanceBlock(metrics),
  '',
  notes ? `## ユーザのメモ・補足 (反映してください)\n${notes}\n` : '',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '- ハイライト1',
  '- ハイライト2',
].join('\n');

// Legacy single-prompt template — retained for fallback if a stage fails so we
// can still return some narrative.
export const DIARY_PROMPT_TEMPLATE = ({ dateStr, metrics, github, notes }) => {
  const hourlyTable = metrics.hourly_visits
    .map((n, h) => `${String(h).padStart(2, '0')}:00 → ${n}`)
    .filter((_, h) => metrics.hourly_visits[h] > 0)
    .join(', ');
  const domainTable = metrics.top_domains
    .map(d => {
      const display = d.site_name ? `${d.site_name} (${d.domain})` : d.domain;
      const desc = d.description ? ` — ${d.description}` : '';
      return `${display} ${d.count}件 [時間帯 ${d.active_hours.join(',')}]${desc}`;
    })
    .join('\n');
  const githubBlock = github?.commits?.length
    ? github.commits.map(c => `- [${c.repo} ${c.sha}] ${c.message}`).join('\n')
    : github?.error
      ? `(GitHub 取得失敗: ${github.error})`
      : '(GitHub commit なし)';
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const totalBookmarks = created.length + accessed.length;
  // When bookmark count balloons, the prompt becomes too long and the per-item
  // detail dilutes the narrative — fall back to a domain-only summary.
  const BOOKMARK_DETAIL_THRESHOLD = 10;
  let bookmarkSection;
  if (totalBookmarks === 0) {
    bookmarkSection = '新規・再訪したブックマーク: (なし)';
  } else if (totalBookmarks > BOOKMARK_DETAIL_THRESHOLD) {
    const allDomains = new Map();
    for (const b of [...created, ...accessed]) {
      try {
        const dom = new URL(b.url).hostname.toLowerCase();
        allDomains.set(dom, (allDomains.get(dom) || 0) + (b.access_count || 1));
      } catch {}
    }
    const domLines = [...allDomains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([d, n]) => `- ${d} (${n} 件)`)
      .join('\n');
    bookmarkSection = [
      `ブックマーク総数: 新規 ${created.length} 件 + 再訪 ${accessed.length} 件 = ${totalBookmarks} 件`,
      '(個別タイトルは省略。ドメイン分布から作業内容を推察してください)',
      domLines,
    ].join('\n');
  } else {
    const createdBlock = created.length
      ? created.map(b => `- ${b.title} (${b.url})${b.summary ? '\n  ' + b.summary.slice(0, 200) : ''}`).join('\n')
      : '(新規ブックマークなし)';
    const accessedBlock = accessed.length
      ? accessed.map(b => `- ${b.title} ×${b.access_count} (${b.url})`).join('\n')
      : '(再訪したブックマークなし)';
    bookmarkSection = `新規ブックマーク:\n${createdBlock}\n\n再訪したブックマーク:\n${accessedBlock}`;
  }
  const notesBlock = notes ? `\nUSER NOTES (反映してください):\n${notes}\n` : '';
  return [
    `あなたは ${dateStr} の活動データから 1 日の日報を書きます。`,
    '事実だけを淡々と。憶測や創作はせず、データから読み取れる活動のみを書きます。',
    '',
    '出力フォーマット (markdown):',
    '## 全体像',
    '一段落で「何時頃から何時頃まで何をしていた風」かをまとめる。',
    '## 時間帯別',
    '- HH:00 〜 HH:00: ドメインから推測される作業',
    '## ブックマーク',
    '- 新規追加・再訪したブックマークから読み取れる関心',
    '## ハイライト',
    '- GitHub commit、印象的な調査、ニュース等',
    '',
    `日付: ${dateStr}`,
    `総アクセス: ${metrics.total_events}`,
    `ユニークドメイン: ${metrics.unique_domains}`,
    `アクティブ時間帯: ${hourlyTable || '(なし)'}`,
    '',
    'TOP DOMAINS:',
    domainTable || '(なし)',
    '',
    bookmarkSection,
    '',
    'GITHUB COMMITS:',
    githubBlock,
    notesBlock,
  ].join('\n');
};

/**
 * Build the URL list for the work-content prompt. Format: "HH:MM <url>" per line,
 * deduped consecutively (collapse runs of the same URL within 2 minutes).
 */
export function buildUrlList(db, dateStr) {
  const events = visitEventsForDate(db, dateStr);
  if (events.length === 0) {
    // Fall back to page_visits where last_seen is the date.
    const visits = db.prepare(`
      SELECT v.url, v.last_seen_at FROM page_visits v
      WHERE date(v.last_seen_at, 'localtime') = ?
      ORDER BY v.last_seen_at ASC
    `).all(dateStr);
    return visits.map(v => formatUrlLine(v.last_seen_at, v.url)).join('\n');
  }
  const lines = [];
  let lastUrl = '';
  let lastTs = 0;
  for (const e of events) {
    const ts = parseSqliteUtc(e.visited_at)?.getTime() || 0;
    if (e.url === lastUrl && Math.abs(ts - lastTs) < 120_000) continue; // collapse <2min
    lines.push(formatUrlLine(e.visited_at, e.url));
    lastUrl = e.url;
    lastTs = ts;
  }
  // Cap to a sane upper bound to avoid stalling Sonnet.
  return lines.slice(-800).join('\n');
}

export function formatUrlLine(ts, url) {
  // ts is a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS'). Parse as UTC then
  // emit the local HH:MM so claude sees the user's wall-clock time, not
  // UTC offset by the local timezone.
  const d = parseSqliteUtc(ts);
  if (!d || isNaN(d.getTime())) return `??:?? ${url}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} ${url}`;
}

export function appendMemoAndImprove(prompt, { globalMemo, improve } = {}) {
  const tail = [];
  if (globalMemo && globalMemo.trim()) {
    tail.push('', '## ユーザの常設メモ (毎回参照)', globalMemo.trim());
  }
  if (improve && improve.trim()) {
    tail.push('', '## このターンだけの改善指示 (最優先)', improve.trim());
  }
  return tail.length > 0 ? `${prompt}\n${tail.join('\n')}` : prompt;
}

export const WEEKLY_PROMPT = ({ weekStart, weekEnd, dailyBlock, githubBlock }) => [
  `あなたは ${weekStart} から ${weekEnd} までの「週報」を書きます。`,
  '7 日分の日報と GitHub コミットヒストリから、週全体での実作業を統合してください。',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '## 今週やったこと',
  '一段落で週全体を概観。',
  '## 主な成果',
  '- 箇条書き。GitHub commit から実装した機能・修正を中心に。',
  '- 進捗が大きかったプロジェクトを優先。',
  '## トピック別',
  '- 学んだこと・調べたこと (作業内容ベース)',
  '## 来週への引き継ぎ',
  '- 未完了に見える作業やフォローアップ',
  '',
  '出力ルール:',
  '- 創作禁止。日報と commit に基づくこと',
  '- リポジトリ名は短く (org/ は省いて末尾のみで OK)',
  '',
  '## 入力 1: 日報サマリ (日付ごと)',
  dailyBlock,
  '',
  '## 入力 2: GitHub commit ヒストリ',
  githubBlock,
].join('\n');

export function buildBookmarkSummary(metrics) {
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const domSet = new Set();
  for (const b of [...created, ...accessed]) {
    try { domSet.add(new URL(b.url).hostname); } catch {}
  }
  return {
    created: created.length,
    accessed: accessed.length,
    topDomains: [...domSet].slice(0, 8),
  };
}

export function composeSummary({ workContent, githubByRepo, highlights, digs }) {
  const parts = [];
  if (workContent) parts.push(`## 作業内容\n${workContent.trim()}`);
  if (digs && digs.length > 0) {
    const digLines = digs.map(d => {
      const head = `- 「${d.query}」 (${d.source_count} 件のソース)`;
      return d.summary ? `${head}\n  ${d.summary.slice(0, 250)}` : head;
    }).join('\n');
    parts.push(`## ディグ調査\n${digLines}`);
  }
  if (githubByRepo.repos.length) {
    const repoLines = githubByRepo.repos
      .map(r => `- ${r.repo}: ${r.count} commits`)
      .join('\n');
    parts.push(`## GitHub commits (${githubByRepo.total} 件)\n${repoLines}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}
