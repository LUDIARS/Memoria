import type { AlexaTaskRegistrationResult } from './task-registration.js';
import type { AlexaPendingNotification } from './store.js';
import { normalizeAlexaText } from './store.js';
import type { AlexaRequestEnvelope, AlexaResponseEnvelope } from './types.js';

const HELP_TEXT = 'タスクを追加するには、買い物をタスクに追加、と話してください。通知を読むこともできます。';

export interface AlexaSkillDeps {
  createTask: (input: { requestId: string; title: string }) => AlexaTaskRegistrationResult;
  takeNotifications: (limit: number) => { items: AlexaPendingNotification[]; remaining: number };
  applySubscriptionChange: (input: {
    userId: string;
    apiEndpoint: string;
    timestamp: string;
    subscriptions: string[];
  }) => void;
}

function speechResponse(
  text: string,
  options: { shouldEndSession?: boolean; reprompt?: string } = {},
): AlexaResponseEnvelope {
  const response: AlexaResponseEnvelope['response'] = {
    outputSpeech: { type: 'PlainText', text },
    shouldEndSession: options.shouldEndSession ?? true,
  };
  if (options.reprompt) {
    response.reprompt = { outputSpeech: { type: 'PlainText', text: options.reprompt } };
  }
  return { version: '1.0', response };
}

function emptyResponse(): AlexaResponseEnvelope {
  return { version: '1.0', response: {} };
}

function taskTitle(envelope: AlexaRequestEnvelope): string {
  return normalizeAlexaText(envelope.request.intent?.slots?.TaskTitle?.value, 201);
}

function notificationSpeech(
  items: AlexaPendingNotification[],
  remaining: number,
): string {
  if (items.length === 0) return `未読の通知はありません。${HELP_TEXT}`;
  const messages = items.map((item, index) => {
    const body = item.body ? `。${item.body}` : '';
    return `${index + 1}件目。${item.title}${body}`;
  });
  const remainingText = remaining > 0 ? `。残り${remaining}件あります` : '';
  return `${items.length + remaining}件の未読通知があります。${messages.join('。')}${remainingText}`;
}

function handleIntentRequest(
  envelope: AlexaRequestEnvelope,
  deps: AlexaSkillDeps,
): AlexaResponseEnvelope {
  const intentName = envelope.request.intent?.name;
  if (!intentName) return speechResponse('インテントを確認できませんでした。もう一度お願いします。');

  if (intentName === 'CreateTaskIntent') {
    const title = taskTitle(envelope);
    if (!title) {
      const prompt = '追加するタスクを教えてください。';
      return speechResponse(prompt, { shouldEndSession: false, reprompt: prompt });
    }
    if (title.length > 200) {
      const prompt = 'タスク名が長すぎます。200文字以内で、もう一度お願いします。';
      return speechResponse(prompt, { shouldEndSession: false, reprompt: prompt });
    }
    const result = deps.createTask({ requestId: envelope.request.requestId, title });
    return result.created
      ? speechResponse(`「${result.task.title}」をタスクに追加しました。`)
      : speechResponse(`「${result.task.title}」はすでにタスクへ追加済みです。`);
  }

  if (intentName === 'ReadNotificationsIntent') {
    const pending = deps.takeNotifications(5);
    return speechResponse(notificationSpeech(pending.items, pending.remaining));
  }

  if (intentName === 'AMAZON.HelpIntent') {
    return speechResponse(HELP_TEXT, { shouldEndSession: false, reprompt: HELP_TEXT });
  }
  if (intentName === 'AMAZON.CancelIntent' || intentName === 'AMAZON.StopIntent') {
    return speechResponse('わかりました。');
  }
  return speechResponse(`すみません、うまく理解できませんでした。${HELP_TEXT}`, {
    shouldEndSession: false,
    reprompt: HELP_TEXT,
  });
}

function handleSubscriptionChange(
  envelope: AlexaRequestEnvelope,
  deps: AlexaSkillDeps,
): AlexaResponseEnvelope {
  const userId = envelope.context.System.user?.userId;
  const apiEndpoint = envelope.context.System.apiEndpoint;
  const subscriptions = envelope.request.body?.subscriptions;
  if (!userId || !apiEndpoint || !subscriptions) {
    throw new Error('Alexa subscription event is missing required fields');
  }
  deps.applySubscriptionChange({
    userId,
    apiEndpoint,
    timestamp: envelope.request.timestamp,
    subscriptions: subscriptions.map((item) => item.eventName),
  });
  return emptyResponse();
}

export function handleAlexaRequest(
  envelope: AlexaRequestEnvelope,
  deps: AlexaSkillDeps,
): AlexaResponseEnvelope {
  switch (envelope.request.type) {
    case 'LaunchRequest': {
      const pending = deps.takeNotifications(5);
      return speechResponse(notificationSpeech(pending.items, pending.remaining));
    }
    case 'IntentRequest':
      return handleIntentRequest(envelope, deps);
    case 'AlexaSkillEvent.ProactiveSubscriptionChanged':
      return handleSubscriptionChange(envelope, deps);
    case 'SessionEndedRequest':
      return emptyResponse();
    default:
      return speechResponse(`この操作にはまだ対応していません。${HELP_TEXT}`);
  }
}
