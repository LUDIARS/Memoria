// Discord action から Memoria 自身の HTTP API を叩くための薄いクライアント。
// 既存パイプライン (task / bookmark / meal) をそのまま再利用し、 discord/ を
// 「mv するだけで切り出せる」 境界に保つ (domain への直 import を避ける)。

const PORT = Number(process.env.MEMORIA_PORT ?? 5180);
const BASE = `http://127.0.0.1:${PORT}`;

export async function apiPostJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiPostForm(path: string, form: FormData): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: 'POST', body: form });
}
