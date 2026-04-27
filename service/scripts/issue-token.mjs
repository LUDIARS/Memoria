#!/usr/bin/env node
// Mint a Memoria JWT for development / testing.
//
// Usage:
//   node scripts/issue-token.mjs <user_id> [--exp 86400]
//
// Reads MEMORIA_JWT_SECRET from .env / ../.env via Node --env-file-if-exists.

import { signJwt } from '../auth.js';

const args = process.argv.slice(2);
const userId = args[0];
if (!userId) {
  console.error('usage: node scripts/issue-token.mjs <user_id> [--exp <seconds>]');
  process.exit(1);
}
const expIdx = args.indexOf('--exp');
const expSeconds = expIdx >= 0 ? Number(args[expIdx + 1]) : 24 * 60 * 60;

const secret = process.env.MEMORIA_JWT_SECRET;
if (!secret) {
  console.error('MEMORIA_JWT_SECRET is not set. Add it to .env first.');
  process.exit(2);
}

const token = signJwt({ sub: userId, iss: 'memoria-dev' }, secret, { expSeconds });
console.log(token);
