export type SensitiveContentRule =
  | 'private-key'
  | 'access-token'
  | 'email-address'
  | 'local-user-path'
  | 'local-workspace-path';

export interface SensitiveContentFinding {
  field: string;
  rule: SensitiveContentRule;
  index: number;
}

interface SensitiveContentPattern {
  rule: SensitiveContentRule;
  pattern: RegExp;
}

const SENSITIVE_CONTENT_PATTERNS: readonly SensitiveContentPattern[] = [
  {
    rule: 'private-key',
    pattern: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  },
  {
    rule: 'access-token',
    pattern: /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    rule: 'email-address',
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  },
  {
    rule: 'local-user-path',
    pattern: /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s]+|\/mnt\/[a-z]\/Users\/[^/\s]+|\/(?:home|Users)\/[^/\s]+)/i,
  },
  {
    rule: 'local-workspace-path',
    pattern: /[A-Z]:[\\/]+Document[\\/]+Ars(?:[\\/]|\b)/i,
  },
];

/**
 * 公開先へコピーすべきでない一般的な秘密情報とローカル識別子を検出する。
 * @implements SPEC-AI-NOTION-TRANSFER-SAFETY
 */
export function scanSensitiveContent(
  fields: Readonly<Record<string, string | null | undefined>>,
): SensitiveContentFinding[] {
  const findings: SensitiveContentFinding[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const { rule, pattern } of SENSITIVE_CONTENT_PATTERNS) {
      const match = pattern.exec(value);
      if (match) findings.push({ field, rule, index: match.index });
    }
  }

  return findings;
}
