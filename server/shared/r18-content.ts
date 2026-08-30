export interface R18ContentFinding {
  field: string;
  rule: 'explicit-adult-content';
  index: number;
}

const EXPLICIT_ADULT_CONTENT = /(?:R-?18|18禁|成人向け|アダルト|ポルノ|エロ(?:ゲ|画像|動画|漫画)|性的(?:描写|行為|コンテンツ)|セックス|性交|性器|自慰|淫乱|わいせつ|猥褻|\b(?:porn(?:ography|ographic)?|hentai|nsfw)\b|explicit sexual|sexual intercourse)/iu;

/**
 * 教育機関向け Notion へ転送しない明示的な成人向け表現を検出する。
 * @implements SPEC-AI-NOTION-TRANSFER-SAFETY
 */
export function scanR18Content(
  fields: Readonly<Record<string, string | null | undefined>>,
): R18ContentFinding[] {
  const findings: R18ContentFinding[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const match = EXPLICIT_ADULT_CONTENT.exec(value);
    if (match) findings.push({ field, rule: 'explicit-adult-content', index: match.index });
  }

  return findings;
}
