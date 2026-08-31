import type { NotionTransferFinding } from './notion-transfer-check.js';

export type NotionTransferDisposition =
  | 'transferable'
  | 'generalization-required'
  | 'blocked';

const GENERALIZABLE_SENSITIVE_RULES = new Set([
  'local-user-path',
  'local-workspace-path',
  'absolute-local-path',
  'environment-configuration',
  'local-runtime-endpoint',
  'personal-environment-context',
]);

/** 原文の所見を、そのまま転送・汎用化レビュー・転送不可の3区分へ分類する。 */
export function classifyNotionTransferDisposition(
  findings: readonly NotionTransferFinding[],
): NotionTransferDisposition {
  if (findings.length === 0) return 'transferable';
  if (findings.every((finding) => {
    if (finding.check === 'project-confidentiality') {
      return finding.rule !== 'invalid-project-source-metadata';
    }
    return finding.check === 'sensitive-content'
      && GENERALIZABLE_SENSITIVE_RULES.has(finding.rule);
  })) return 'generalization-required';
  return 'blocked';
}
