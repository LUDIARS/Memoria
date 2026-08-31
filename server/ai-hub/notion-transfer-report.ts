import type { NotionTransferResult } from './notion-transfer-check.js';

export interface NotionTransferReport {
  total: number;
  transferable: number;
  blocked: number;
  checks: {
    configuredRedactionTerms: number;
    redactionBlocked: number;
    projectConfidentialityBlocked: number;
    sensitiveContentBlocked: number;
    r18Blocked: number;
  };
  blockedArticles: Array<{
    id: number;
    title: string;
    reasons: string[];
  }>;
}

const REDACTED_TITLE = '[redacted: title matched a safety rule]';

/** @implements SPEC-AI-NOTION-TRANSFER-SAFETY */
export function buildNotionTransferReport(
  results: readonly NotionTransferResult[],
  configuredRedactionTerms: number,
): NotionTransferReport {
  const blocked = results.filter((result) => !result.transferable);
  const countBlockedBy = (check: NotionTransferResult['findings'][number]['check']): number => (
    results.filter((result) => result.findings.some((finding) => finding.check === check)).length
  );

  return {
    total: results.length,
    transferable: results.length - blocked.length,
    blocked: blocked.length,
    checks: {
      configuredRedactionTerms,
      redactionBlocked: countBlockedBy('redaction'),
      projectConfidentialityBlocked: countBlockedBy('project-confidentiality'),
      sensitiveContentBlocked: countBlockedBy('sensitive-content'),
      r18Blocked: countBlockedBy('r18'),
    },
    blockedArticles: blocked.map((result) => ({
      id: result.id,
      title: result.findings.some((finding) => finding.field === 'title')
        ? REDACTED_TITLE
        : result.title,
      reasons: [...new Set(result.findings.map((finding) => `${finding.check}:${finding.rule}`))],
    })),
  };
}

/** @implements SPEC-AI-NOTION-TRANSFER-SAFETY */
export function formatNotionTransferReport(report: NotionTransferReport): string {
  return [
    `Checked: ${report.total}`,
    `Transferable: ${report.transferable}`,
    `Blocked: ${report.blocked}`,
    `Configured redaction terms: ${report.checks.configuredRedactionTerms}`,
    `Redaction blocked: ${report.checks.redactionBlocked}`,
    `Project confidentiality blocked: ${report.checks.projectConfidentialityBlocked}`,
    `Sensitive content blocked: ${report.checks.sensitiveContentBlocked}`,
    `R18 blocked: ${report.checks.r18Blocked}`,
    'Blocked articles:',
    ...report.blockedArticles.map((article) => (
      `- [${article.id}] ${article.title} (${article.reasons.join(', ')})`
    )),
    '',
  ].join('\n');
}
