// 共有前の禁止語スキャン (push 経路の内側に置く必須ゲート)。
// Spec: spec/feature/hub-achievements.md §4.3 / spec/interface/hub-social.md §6.5
//
// achievements と AIノートの両方が通るので、 domain 配下ではなく shared に置く
// (domain 間 cross-import 禁止のため)。

export interface RedactionFinding {
  /** 該当したフィールド名 (呼び出し側が渡したキー)。 */
  field: string;
  /** 辞書に登録された原形の語 (正規化前)。 */
  term: string;
  /** 正規化後の文字列内の位置。 原文のオフセットとは一致しない (目印用)。 */
  index: number;
}

/** 表記ゆれを畳んでから照合する。元データは変更しない。 */
export function normalizeForScan(input: string): string {
  return input
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[-_\s]/g, '');
}

export function scanForbiddenTerms(
  fields: Readonly<Record<string, string | null | undefined>>,
  terms: readonly string[],
): RedactionFinding[] {
  const findings: RedactionFinding[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const normalizedValue = normalizeForScan(value);
    for (const term of terms) {
      const normalizedTerm = normalizeForScan(term);
      if (!normalizedTerm) continue;
      const index = normalizedValue.indexOf(normalizedTerm);
      if (index >= 0) findings.push({ field, term, index });
    }
  }

  return findings;
}
