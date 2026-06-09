// Hora (デスクトップおじさん) へのブリーフィング送信。 Hora がローカルで listen する
// HTTP エンドポイント (既定 http://127.0.0.1:5179/api/say) に POST する。 best-effort。
//
// Hora 側の受信実装は Hora リポの src-tauri ローカル listener を参照。

export interface HoraSayPayload {
  source: string;
  kind: string;
  text: string;
}

const TIMEOUT_MS = 8_000;

export async function postBriefingToHora(url: string, text: string): Promise<boolean> {
  try {
    const payload: HoraSayPayload = { source: 'memoria-briefing', kind: 'briefing', text };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // Hora 未起動 / 受信未対応でも本筋は止めない。
    return false;
  }
}
