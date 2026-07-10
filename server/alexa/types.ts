import { z } from 'zod';

const AlexaSlotSchema = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
}).loose();

const AlexaIntentSchema = z.object({
  name: z.string().min(1),
  slots: z.record(z.string(), AlexaSlotSchema).optional(),
}).loose();

const AlexaSubscriptionSchema = z.object({
  eventName: z.string().min(1),
}).loose();

export const AlexaRequestEnvelopeSchema = z.object({
  version: z.string().min(1),
  context: z.object({
    System: z.object({
      application: z.object({
        applicationId: z.string().min(1),
      }).loose(),
      user: z.object({
        userId: z.string().min(1),
      }).loose().optional(),
      apiEndpoint: z.string().min(1).optional(),
    }).loose(),
  }).loose(),
  request: z.object({
    type: z.string().min(1),
    requestId: z.string().min(1).max(500),
    timestamp: z.string().min(1),
    locale: z.string().min(1).optional(),
    intent: AlexaIntentSchema.optional(),
    body: z.object({
      subscriptions: z.array(AlexaSubscriptionSchema),
    }).loose().optional(),
  }).loose(),
}).loose();

export type AlexaRequestEnvelope = z.infer<typeof AlexaRequestEnvelopeSchema>;

export interface AlexaSpeech {
  type: 'PlainText';
  text: string;
}

export interface AlexaResponseEnvelope {
  version: '1.0';
  response: {
    outputSpeech?: AlexaSpeech;
    reprompt?: { outputSpeech: AlexaSpeech };
    shouldEndSession?: boolean;
  };
}
