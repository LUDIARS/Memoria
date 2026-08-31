export type SensitiveContentRule =
  | 'private-key'
  | 'access-token'
  | 'email-address'
  | 'local-user-path'
  | 'local-workspace-path'
  | 'absolute-local-path'
  | 'environment-configuration'
  | 'local-runtime-endpoint'
  | 'personal-environment-context';

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
  {
    rule: 'absolute-local-path',
    pattern: /(?<![A-Z0-9])(?:[A-Z]:[\\/]|\/(?:Applications|Library|Users|bin|etc|home|lib|mnt|opt|private|root|sbin|srv|tmp|usr|var|Volumes)\/)/i,
  },
  {
    rule: 'environment-configuration',
    pattern: /(?:環境変数|environment variable|(?:^|[\/\s])\.env(?:\.[A-Za-z0-9_-]+)?\b|(?:process|import\.meta)\.env\b|os\.environ|getenv\s*\(|\$env:[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%)/imu,
  },
  {
    rule: 'environment-configuration',
    pattern: /(?:^|[^A-Za-z0-9_])(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|USERNAME|COMPUTERNAME|CODEX_HOME|ANATOMIA_HOME|CLAUDE_CONFIG_DIR)(?:[^A-Za-z0-9_]|$)/mu,
  },
  {
    rule: 'local-runtime-endpoint',
    pattern: /(?<![A-Z0-9.-])(?:localhost|127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|\[?::1\]?)(?::\d{1,5})?(?![A-Z0-9.-])/i,
  },
  {
    rule: 'personal-environment-context',
    pattern: /(?:個人環境|ローカル環境|自分のPC|個人PC|手元のPC|開発機|マシン固有)/iu,
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
      if (
        match
        && rule === 'absolute-local-path'
        && findings.some((finding) => (
          finding.field === field
          && finding.index === match.index
          && (finding.rule === 'local-user-path' || finding.rule === 'local-workspace-path')
        ))
      ) continue;
      if (match) findings.push({ field, rule, index: match.index });
    }
  }

  return findings;
}
