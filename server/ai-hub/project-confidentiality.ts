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

function projectNameFromRepository(value: string): string | null {
  const repository = value.replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
  const name = repository.split(/[\\/]/).at(-1)?.replace(/\.git$/i, '').trim();
  return name || null;
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

function projectNameIndex(value: string, projectName: string): number {
  const escapedName = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapedName}(?![\\p{L}\\p{N}_])`,
    'iu',
  ).exec(value)?.index ?? -1;
}

/**
 * source_refs に現れるリポジトリ名だけを、本文検査用の案件名として収集する。
 * @implements SPEC-AI-NOTION-TRANSFER-SAFETY
 */
export function collectProjectNamesFromSourceRefs(
  articles: readonly { source_refs?: string | null }[],
): string[] {
  const names = new Set<string>();
  for (const article of articles) {
    if (article.source_refs === null || article.source_refs === undefined) continue;
    const references = parseSourceReferences(article.source_refs);
    if (!references) continue;
    for (const reference of references) {
      if (reference.repo === null || reference.repo === undefined) continue;
      const name = projectNameFromRepository(reference.repo);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * 案件由来の記事を、転送本文と構造化 provenance の両方から検出する。
 * @implements SPEC-AI-NOTION-TRANSFER-SAFETY
 */
export function scanProjectConfidentiality(
  fields: Readonly<Record<string, string | null | undefined>>,
  sourceRefs: string | null | undefined,
  projectNames: readonly string[] = [],
): ProjectConfidentialityFinding[] {
  const findings: ProjectConfidentialityFinding[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const matchIndex = projectNames
      .map((name) => projectNameIndex(value, name))
      .find((index) => index >= 0);
    if (matchIndex !== undefined) {
      findings.push({
        field,
        rule: 'restricted-project-mention',
        index: matchIndex,
      });
    }
  }

  if (sourceRefs === null || sourceRefs === undefined) return findings;
  const references = parseSourceReferences(sourceRefs);
  if (!references) {
    findings.push({ field: 'source_refs', rule: 'invalid-project-source-metadata', index: 0 });
    return findings;
  }
  if (references.some((reference) => (
    typeof reference.repo === 'string' && projectNameFromRepository(reference.repo) !== null
  ))) {
    findings.push({ field: 'source_refs', rule: 'restricted-project-source', index: 0 });
  }

  return findings;
}
