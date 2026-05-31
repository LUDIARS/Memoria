# config — 設定 API (privacy / LLM / tracks / setup-docs)

## privacy

| method | path | req | res |
|---|---|---|---|
| GET | `/api/privacy/settings` | — | `{ settings: PrivacySettings }` |
| PATCH | `/api/privacy/settings` | `PrivacySettingsPatch` | `{ settings: PrivacySettings }` |

## LLM (`/api/llm/config`)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/llm/config` | — | `LlmConfigResponse` |
| PATCH | `/api/llm/config` | `LlmConfigPatch` | `LlmConfigResponse` |

## tracks 描画設定

| method | path | req | res |
|---|---|---|---|
| GET | `/api/tracks/settings` | — | `{ decimate_meters: number, show_polyline: boolean }` |
| PATCH | `/api/tracks/settings` | `{ decimate_meters?, show_polyline? }` | 同上 |

## セットアップ手順 (read-only docs)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/setup-docs` | — | `{ docs: SetupDocSummary[] }` |
| GET | `/api/setup-docs/:key` | — | `SetupDoc` |

## 注意
- `PrivacySettingsPatch` は **部分 patch**。 boolean は明示で送信、 number は range clamp (workplace_match_radius_m: 20-2000m, hour: 0-23, minute: 0-59)。
- LLM 設定の OpenAI key は GET レスポンスで `'***'` にマスク。 PATCH で `'***'` を送ると元の値を保持。
