// server/personality-export/share-token.ts
//
// Voluptas への性格特徴量exportを許可する共有トークンの発行/検証/失効。
// トークン本体は app_settings に保存しない — SHA-256ハッシュのみ永続化し、平文は
// 発行レスポンスで一度だけ返す (Voluptasの招待token・EducationLab連携tokenと同じ「ハッシュのみ保存」パターン)。

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';

type Db = BetterSqlite3.Database;

const TOKEN_HASH_KEY = 'personality_share.token_hash';
const ISSUED_AT_KEY = 'personality_share.issued_at';
const EXPIRES_AT_KEY = 'personality_share.expires_at';

const DEFAULT_TTL_DAYS = 30;

export interface ShareTokenStatus {
  hasToken: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueShareToken(
  db: Db,
  opts: { ttlDays?: number; now?: () => Date } = {}
): { token: string; issuedAt: string; expiresAt: string } {
  const now = opts.now ?? (() => new Date());
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const token = randomBytes(32).toString('base64url');
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  setAppSettings(db, {
    [TOKEN_HASH_KEY]: hashToken(token),
    [ISSUED_AT_KEY]: issuedAt.toISOString(),
    [EXPIRES_AT_KEY]: expiresAt.toISOString(),
  });
  return { token, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

export function revokeShareToken(db: Db): void {
  setAppSettings(db, { [TOKEN_HASH_KEY]: null, [ISSUED_AT_KEY]: null, [EXPIRES_AT_KEY]: null });
}

export function getShareTokenStatus(db: Db): ShareTokenStatus {
  const s = getAppSettings(db);
  return {
    hasToken: !!s[TOKEN_HASH_KEY],
    issuedAt: s[ISSUED_AT_KEY] ?? null,
    expiresAt: s[EXPIRES_AT_KEY] ?? null,
  };
}

/** 提示されたトークンが有効 (ハッシュ一致 かつ 未失効) かを確認する。 */
export function verifyShareToken(db: Db, presented: string, now: () => Date = () => new Date()): boolean {
  if (!presented) return false;
  const s = getAppSettings(db);
  const storedHash = s[TOKEN_HASH_KEY];
  if (!storedHash) return false;
  const expiresAt = s[EXPIRES_AT_KEY];
  if (!expiresAt) return false;
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || now().getTime() >= expiresAtMs) return false;

  const presentedHash = hashToken(presented);
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(presentedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
