/** CLI 引数の解釈 (純関数)。 */
import { parseMonth } from './period.js';
import type { AuthorIdentity } from './types.js';

export interface CliOptions {
  months: string[];
  authors: AuthorIdentity[];
  outHtml: string | null;
  outJson: string | null;
  cachePath: string;
  excludeRepo: RegExp | null;
}

export const USAGE = `usage: npm run code-volume -- --months 2025-09,2026-09 --author <login> [--author-email <email>]...
  [--out <report.html>] [--json <report.json>] [--cache <commits.json>] [--exclude-repo <regex>]`;

export function parseCliArgs(argv: string[], defaults: { cachePath: string }): CliOptions {
  const opts: CliOptions = { months: [], authors: [], outHtml: null, outJson: null, cachePath: defaults.cachePath, excludeRepo: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`${key} needs a value\n${USAGE}`);
    i += 1;
    switch (key) {
      case '--months':
        for (const m of val.split(',').map((s) => s.trim()).filter(Boolean)) {
          parseMonth(m);
          opts.months.push(m);
        }
        break;
      case '--author': opts.authors.push({ kind: 'login', value: val }); break;
      case '--author-email': opts.authors.push({ kind: 'email', value: val }); break;
      case '--out': opts.outHtml = val; break;
      case '--json': opts.outJson = val; break;
      case '--cache': opts.cachePath = val; break;
      case '--exclude-repo': opts.excludeRepo = new RegExp(val); break;
      default: throw new Error(`unknown option: ${key}\n${USAGE}`);
    }
  }
  if (opts.months.length === 0) throw new Error(`--months is required\n${USAGE}`);
  if (opts.authors.length === 0) throw new Error(`--author or --author-email is required\n${USAGE}`);
  return opts;
}
