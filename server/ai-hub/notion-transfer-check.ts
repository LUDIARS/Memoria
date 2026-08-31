import { scanForbiddenTerms } from '../shared/redaction.js';
import { scanR18Content } from '../shared/r18-content.js';
import { scanSensitiveContent } from '../shared/sensitive-content.js';
import { scanProjectConfidentiality } from './project-confidentiality.js';

export interface NotionTransferArticle {
  id: number;
  title: string;
  body_md: string;
  source_refs?: string | null;
}

export type NotionTransferCheck =
  | 'redaction'
  | 'project-confidentiality'
  | 'sensitive-content'
  | 'r18';

export interface NotionTransferFinding {
  check: NotionTransferCheck;
  field: string;
  rule: string;
  index: number;
}

export interface NotionTransferResult {
  id: number;
  title: string;
  transferable: boolean;
  findings: NotionTransferFinding[];
}

/**
 * Notion へ実際に転送する title/body だけを、既存の共有ゲート + 追加安全規則で検査する。
 * @implements SPEC-AI-NOTION-TRANSFER-SAFETY
 */
export function checkNotionTransfer(
  article: NotionTransferArticle,
  forbiddenTerms: readonly string[],
): NotionTransferResult {
  const fields = { title: article.title, body_md: article.body_md };
  const findings: NotionTransferFinding[] = [
    ...scanForbiddenTerms(fields, forbiddenTerms).map((finding) => ({
      check: 'redaction' as const,
      field: finding.field,
      // 禁止語辞書自体が機密になり得るため、結果へ原語を出さない。
      rule: 'configured-forbidden-term',
      index: finding.index,
    })),
    ...scanProjectConfidentiality(fields, article.source_refs).map((finding) => ({
      check: 'project-confidentiality' as const,
      ...finding,
    })),
    ...scanSensitiveContent(fields).map((finding) => ({
      check: 'sensitive-content' as const,
      ...finding,
    })),
    ...scanR18Content(fields).map((finding) => ({
      check: 'r18' as const,
      ...finding,
    })),
  ];

  return {
    id: article.id,
    title: article.title,
    transferable: findings.length === 0,
    findings,
  };
}
