export type AlexaProactiveStage = 'development' | 'live';

export interface AlexaConfig {
  skillId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  proactiveStage: AlexaProactiveStage;
  inboundEnabled: boolean;
  proactiveEnabled: boolean;
}

const ALEXA_API_ENDPOINTS = new Set([
  'https://api.amazonalexa.com',
  'https://api.eu.amazonalexa.com',
  'https://api.fe.amazon.com',
]);

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

export function loadAlexaConfig(env: NodeJS.ProcessEnv = process.env): AlexaConfig {
  const skillId = optionalEnv(env, 'MEMORIA_ALEXA_SKILL_ID');
  const clientId = optionalEnv(env, 'MEMORIA_ALEXA_CLIENT_ID');
  const clientSecret = optionalEnv(env, 'MEMORIA_ALEXA_CLIENT_SECRET');
  const stageValue = optionalEnv(env, 'MEMORIA_ALEXA_PROACTIVE_STAGE') ?? 'development';

  if (stageValue !== 'development' && stageValue !== 'live') {
    throw new Error('MEMORIA_ALEXA_PROACTIVE_STAGE must be development or live');
  }
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new Error('MEMORIA_ALEXA_CLIENT_ID and MEMORIA_ALEXA_CLIENT_SECRET must be configured together');
  }
  if ((clientId || clientSecret) && !skillId) {
    throw new Error('MEMORIA_ALEXA_SKILL_ID is required when proactive credentials are configured');
  }

  return {
    skillId,
    clientId,
    clientSecret,
    proactiveStage: stageValue,
    inboundEnabled: skillId !== null,
    proactiveEnabled: skillId !== null && clientId !== null && clientSecret !== null,
  };
}

export function normalizeAlexaApiEndpoint(value: string): string | null {
  const normalized = value.trim().replace(/\/$/, '');
  return ALEXA_API_ENDPOINTS.has(normalized) ? normalized : null;
}

export function proactiveEventsUrl(
  apiEndpoint: string,
  stage: AlexaProactiveStage,
): string {
  const endpoint = normalizeAlexaApiEndpoint(apiEndpoint);
  if (!endpoint) throw new Error('unsupported Alexa API endpoint');
  return stage === 'development'
    ? `${endpoint}/v1/proactiveEvents/stages/development`
    : `${endpoint}/v1/proactiveEvents`;
}
