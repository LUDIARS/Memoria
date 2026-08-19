/**
 * spending log を LLM に渡してよい範囲 (llm_relay_scope) の判定だけを持つ。
 *
 * 契約拡張 (2026-08-19): 従来は Quaestor が宣言する `diary_only` 固定で、 日記生成以外の
 * LLM 処理へ渡すことを構造的に禁止していた。 消費傾向の助言を出すために
 * `diary_and_spending_advice` を追加する。 ただし拡張は無条件ではなく、
 *
 *   1. 本人が Memoria 側で明示同意 (spending_advice.consent) している
 *   2. 送信先が loopback のローカル LLM である (local-llm.ts が入口で検証)
 *
 * の 2 条件を満たすときだけ有効になる。 同意が無い行は `diary_only` のままで、
 * 助言生成の入力から除外される。
 */

export const LLM_RELAY_SCOPES = ['diary_only', 'diary_and_spending_advice'] as const;

export type LlmRelayScope = (typeof LLM_RELAY_SCOPES)[number];

export const DIARY_ONLY_SCOPE: LlmRelayScope = 'diary_only';
export const SPENDING_ADVICE_SCOPE: LlmRelayScope = 'diary_and_spending_advice';

/** scope の広さ。 大きいほど広い。 */
const SCOPE_RANK: Record<LlmRelayScope, number> = {
  diary_only: 0,
  diary_and_spending_advice: 1,
};

/**
 * 保存時に採用する実効 scope。 外部サービスの宣言では権限を広げず、 Memoria 上の
 * 本人同意だけで助言 scope へ昇格する。
 */
export function resolveEffectiveRelayScope(hasSpendingAdviceConsent: boolean): LlmRelayScope {
  return hasSpendingAdviceConsent ? SPENDING_ADVICE_SCOPE : DIARY_ONLY_SCOPE;
}

/** 消費傾向助言の LLM プロンプトに載せてよい行か。 */
export function allowsSpendingAdviceRelay(scope: LlmRelayScope): boolean {
  return SCOPE_RANK[scope] >= SCOPE_RANK[SPENDING_ADVICE_SCOPE];
}
