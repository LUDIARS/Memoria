// Frontend-side API request/response types.
//
// 旧 JS から TS 化した app.ts は動的さが強く strict 型付けが難しいため、
// 暫定的に typecheck からは除外している (tsconfig.frontend.json を参照)。
//
// 段階的に domain ごと module を切り出すフェーズで、 切り出した module は
// このファイルから API 型を import して narrow に書き直す予定。
//
// backend 側の strict な型は server/api/types/<domain>.ts にある。 frontend
// から重複コピーするのではなく、 必要に応じて再 export する形を想定。

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

// 旧 JS の動的 access を取り回すための record-y type。 値型は unknown。
export type Loose = { [k: string]: unknown };
