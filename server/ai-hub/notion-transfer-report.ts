import type { NotionTransferResult } from './notion-transfer-check.js';

export interface NotionTransferReport {
  total: number;
  transferable: number;
  generalizationRequired: number;
  blocked: number;
  checks: {
    configuredRedactionTerms: number;
    redactionBlocked: number;
    projectConfidentialityFlagged: number;
    sensitiveContentFlagged: number;
    r18Blocked: number;
  };
  generalizationCandidates: Array<{
    id: number;
    title: string;
    reasons: string[];
  }>;
  blockedArticles: Array<{
    id: number;
    title: string;
    reasons: string[];
  }>;
}

type ReportedArticle = NotionTransferReport['blockedArticles'][number];

const REDACTED_TITLE = '[redacted: title matched a safety rule]';

function buildReportedArticles(results: readonly NotionTransferResult[]): ReportedArticle[] {
  return results.map((result) => ({
    id: result.id,
    title: result.findings.some((finding) => finding.field === 'title')
      ? REDACTED_TITLE
      : result.title,
    reasons: [...new Set(result.findings.map((finding) => `${finding.check}:${finding.rule}`))],
  }));
}

/** @implements SPEC-AI-NOTION-TRANSFER-SAFETY */
export function buildNotionTransferReport(
  results: readonly NotionTransferResult[],
  configuredRedactionTerms: number,
): NotionTransferReport {
  const generalizationCandidates = results.filter(
    (result) => result.disposition === 'generalization-required',
  );
  const blocked = results.filter((result) => result.disposition === 'blocked');
  const countBlockedBy = (check: NotionTransferResult['findings'][number]['check']): number => (
    results.filter((result) => result.findings.some((finding) => finding.check === check)).length
  );

  return {
    total: results.length,
    transferable: results.filter((result) => result.disposition === 'transferable').length,
    generalizationRequired: generalizationCandidates.length,
    blocked: blocked.length,
    checks: {
      configuredRedactionTerms,
      redactionBlocked: countBlockedBy('redaction'),
      projectConfidentialityFlagged: countBlockedBy('project-confidentiality'),
      sensitiveContentFlagged: countBlockedBy('sensitive-content'),
      r18Blocked: countBlockedBy('r18'),
    },
    generalizationCandidates: buildReportedArticles(generalizationCandidates),
    blockedArticles: buildReportedArticles(blocked),
  };
}

/** @implements SPEC-AI-NOTION-TRANSFER-SAFETY */
export function formatNotionTransferReport(report: NotionTransferReport): string {
  return [
    `Checked: ${report.total}`,
    `Transferable: ${report.transferable}`,
    `Generalization required: ${report.generalizationRequired}`,
    `Blocked: ${report.blocked}`,
    `Configured redaction terms: ${report.checks.configuredRedactionTerms}`,
    `Redaction blocked: ${report.checks.redactionBlocked}`,
    `Project confidentiality flagged: ${report.checks.projectConfidentialityFlagged}`,
    `Sensitive content flagged: ${report.checks.sensitiveContentFlagged}`,
    `R18 blocked: ${report.checks.r18Blocked}`,
    'Generalization candidates:',
    ...report.generalizationCandidates.map((article) => (
      `- [${article.id}] ${article.title} (${article.reasons.join(', ')})`
    )),
    'Blocked articles:',
    ...report.blockedArticles.map((article) => (
      `- [${article.id}] ${article.title} (${article.reasons.join(', ')})`
    )),
    '',
  ].join('\n');
}
