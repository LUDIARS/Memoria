// briefing ドメインの公開バレル。 scheduler / route / 設定 UI はここから import する。

export { getBriefingConfig } from './config.js';
export type { BriefingConfig } from './config.js';
export { buildBriefing } from './compose.js';
export { formatForDiscord, formatForHora } from './format.js';
export { postBriefingToHora } from './hora.js';
export { startBriefingScheduler } from './scheduler.js';
export type { Briefing, SectionBlock } from './types.js';
