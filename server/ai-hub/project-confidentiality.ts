export type ProjectConfidentialityRule =
  | 'restricted-project-source'
  | 'restricted-project-mention'
  | 'invalid-project-source-metadata';

export interface ProjectConfidentialityFinding {
  field: string;
  rule: ProjectConfidentialityRule;
  index: number;
}

interface ProjectSourceReference {
  kind: string;
  ref: string;
  repo?: string | null;
}

const RESTRICTED_PROJECT_NAMES = new Set([
  'makainui',
  'ludellus',
  'ludellus-server',
  'ludellus-native',
  'ludellus-core',
  'kuzusurvivors',
  'ks',
  'privategame',
  'superfat',
]);

const RESTRICTED_PROJECT_MENTION = /(?:MakaiNui|魔界ぬい|Ludellus(?:-(?:Server|Native|Core))?|KuzuSurvivors|(?<![A-Z0-9_])KS(?![A-Z0-9_])|PrivateGame|SUPERFAT)/iu;

function isRestrictedProjectReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value
    .split(/[\\/]/)
    .map((part) => part.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\.git$/, ''))
    .some((part) => RESTRICTED_PROJECT_NAMES.has(part));
}

function isProjectSourceReference(value: unknown): value is ProjectSourceReference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === 'string'
    && typeof candidate.ref === 'string'
    && (candidate.repo === undefined || candidate.repo === null || typeof candidate.repo === 'string');
}

function parseSourceReferences(sourceRefs: string): ProjectSourceReference[] | null {
  try {
    const parsed: unknown = JSON.parse(sourceRefs);
    return Array.isArray(parsed) && parsed.every(isProjectSourceReference) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 案件由来の記事を、転送本文と構造化 provenance の両方から検出する。
 * @implements SPEC-AI-NOTION-TRANSFER-SAFETY
 */
export function scanProjectConfidentiality(
  fields: Readonly<Record<string, string | null | undefined>>,
  sourceRefs: string | null | undefined,
): ProjectConfidentialityFinding[] {
  const findings: ProjectConfidentialityFinding[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const match = RESTRICTED_PROJECT_MENTION.exec(value);
    if (match) findings.push({ field, rule: 'restricted-project-mention', index: match.index });
  }

  if (sourceRefs === null || sourceRefs === undefined) return findings;
  const references = parseSourceReferences(sourceRefs);
  if (!references) {
    findings.push({ field: 'source_refs', rule: 'invalid-project-source-metadata', index: 0 });
    return findings;
  }
  if (references.some((reference) => isRestrictedProjectReference(reference.repo))) {
    findings.push({ field: 'source_refs', rule: 'restricted-project-source', index: 0 });
  }

  return findings;
}
