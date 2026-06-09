// ブリーフィングを sink ごとのテキストに描画する。
//   - Discord: Markdown (見出し太字)、 1900 字で分割した配列
//   - Hora:    平文 (おじさんが読み上げ/表示する素材)、 単一文字列

import type { Briefing } from './types.js';

const MAX_LEN = 1900;

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 行単位で MAX_LEN に収まるよう分割する。 */
function chunk(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX_LEN) {
      if (buf) out.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

export function formatForDiscord(b: Briefing): string[] {
  const header = `🗒️ **ブリーフィング**（${hhmm(b.generatedAt)}）`;
  const body = b.blocks
    .map((blk) => `**${blk.heading}**\n${blk.lines.join('\n')}`)
    .join('\n\n');
  return chunk(`${header}\n\n${body}`);
}

export function formatForHora(b: Briefing): string {
  const header = `ブリーフィング（${hhmm(b.generatedAt)}）`;
  const body = b.blocks
    .map((blk) => `【${blk.heading}】\n${blk.lines.join('\n')}`)
    .join('\n\n');
  return `${header}\n\n${body}`;
}
