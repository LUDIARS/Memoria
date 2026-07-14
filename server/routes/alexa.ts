import type { IncomingHttpHeaders } from 'node:http';
import { Buffer } from 'node:buffer';
import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import type { AlexaConfig } from '../alexa/config.js';
import { handleAlexaRequest } from '../alexa/skill.js';
import {
  applyAlexaSubscriptionChange,
  takeAlexaNotifications,
} from '../alexa/store.js';
import { registerAlexaTask } from '../alexa/task-registration.js';
import { AlexaRequestEnvelopeSchema } from '../alexa/types.js';
import {
  verifyAlexaRequest,
  type AlexaRequestVerifier,
} from '../alexa/verifier.js';

type Db = BetterSqlite3.Database;

const MAX_REQUEST_BYTES = 64 * 1024;

export interface AlexaRouterDeps {
  db: Db;
  config: AlexaConfig;
  verifyRequest?: AlexaRequestVerifier;
}

function requestHeaders(context: Context): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  context.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export function makeAlexaRouter(deps: AlexaRouterDeps): Hono {
  const router = new Hono();
  const verifyRequest = deps.verifyRequest ?? verifyAlexaRequest;

  router.post('/api/alexa/skill', async (context: Context) => {
    if (!deps.config.inboundEnabled || !deps.config.skillId) {
      return context.json({ error: 'Alexa integration is not configured' }, 503);
    }

    const contentLength = Number(context.req.header('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return context.json({ error: 'request body too large' }, 413);
    }

    const rawBody = await context.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
      return context.json({ error: 'request body too large' }, 413);
    }

    try {
      await verifyRequest(rawBody, requestHeaders(context));
    } catch {
      return context.json({ error: 'Alexa request verification failed' }, 400);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return context.json({ error: 'invalid JSON' }, 400);
    }
    const parsed = AlexaRequestEnvelopeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return context.json({ error: 'invalid Alexa request envelope' }, 400);
    }
    if (parsed.data.context.System.application.applicationId !== deps.config.skillId) {
      return context.json({ error: 'Alexa application ID mismatch' }, 403);
    }

    try {
      const response = handleAlexaRequest(parsed.data, {
        createTask: (input) => registerAlexaTask(deps.db, input),
        takeNotifications: (limit) => takeAlexaNotifications(deps.db, limit),
        applySubscriptionChange: (input) => {
          applyAlexaSubscriptionChange(deps.db, input);
        },
      });
      return context.json(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[alexa] request handling failed: ${message}`);
      return context.json({ error: 'Alexa request handling failed' }, 500);
    }
  });

  return router;
}
