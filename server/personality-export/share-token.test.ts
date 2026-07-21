import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setAppSettings } from '../db.js';
import { issueShareToken, verifyShareToken } from './share-token.js';

const EXPIRES_AT_KEY = 'personality_share.expires_at';

test('verifyShareToken accepts only a matching token before its expiry', () => {
  const db = openDb(':memory:');
  try {
    const issuedAt = new Date('2026-07-20T00:00:00.000Z');
    const issued = issueShareToken(db, { ttlDays: 1, now: () => issuedAt });

    assert.equal(verifyShareToken(db, issued.token, () => new Date('2026-07-20T12:00:00.000Z')), true);
    assert.equal(verifyShareToken(db, 'wrong-token', () => new Date('2026-07-20T12:00:00.000Z')), false);
    assert.equal(verifyShareToken(db, issued.token, () => new Date(issued.expiresAt)), false);
  } finally {
    db.close();
  }
});

test('verifyShareToken fails closed when expires_at is missing or invalid', () => {
  const db = openDb(':memory:');
  try {
    const issued = issueShareToken(db, { now: () => new Date('2026-07-20T00:00:00.000Z') });

    setAppSettings(db, { [EXPIRES_AT_KEY]: null });
    assert.equal(verifyShareToken(db, issued.token), false);

    setAppSettings(db, { [EXPIRES_AT_KEY]: 'not-a-date' });
    assert.equal(verifyShareToken(db, issued.token), false);
  } finally {
    db.close();
  }
});
