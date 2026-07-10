import type { IncomingHttpHeaders } from 'node:http';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';

export type AlexaRequestVerifier = (
  rawBody: string,
  headers: IncomingHttpHeaders,
) => Promise<void>;

const signatureVerifier = new SkillRequestSignatureVerifier();
const timestampVerifier = new TimestampVerifier(150_000);

export const verifyAlexaRequest: AlexaRequestVerifier = async (rawBody, headers) => {
  await signatureVerifier.verify(rawBody, headers);
  await timestampVerifier.verify(rawBody);
};
