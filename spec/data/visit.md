# visit — ページ訪問 (URL 単位サマリ + 個別イベント)

## `page_visits`
URL ごとに 1 行。 first/last 訪問時刻と visit_count。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `url` | TEXT | ✓ | — | PK |
| `title` | TEXT |  | NULL | |
| `first_seen_at` | TEXT | ✓ | UTC | |
| `last_seen_at` | TEXT | ✓ | UTC | |
| `visit_count` | INTEGER | ✓ | 1 | |

Index: `idx_page_visits_last_seen` (`last_seen_at DESC`)

## `visit_events`
1 訪問 = 1 行 (per-event timestamp で日記用)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `url` | TEXT | ✓ | — | |
| `domain` | TEXT |  | NULL | |
| `title` | TEXT |  | NULL | |
| `visited_at` | TEXT | ✓ | UTC | |
| `device_label` | TEXT |  | NULL | Tailscale 名 (例: "iphone-of-foo") |
| `device_os` | TEXT |  | NULL | "iOS" / "Android" / "macOS" / "Windows" / "Linux" |
| `source` | TEXT |  | NULL | `browser` / `dns` / `sni` |

Index: `idx_visit_events_visited_at` / `idx_visit_events_domain`
