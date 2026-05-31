// workplace domain — work_locations
// Spec: spec/data/workplace.md

export interface WorkLocationRow {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  url: string | null;
  /** カンマ区切りの自由タグ ("wifi, 電源, 静か"). */
  tags: string | null;
  /** カンマ区切りの WiFi SSID。 Electron 起動時に matching → 即 checkin に使う
   *  (= GPS / Permission を経由せず「家の WiFi だから家に居る」 と判定)。
   *  1 ワークプレイスに複数 SSID (2.4 GHz / 5 GHz など) を持てる。 */
  wifi_ssids: string | null;
  /** 1 つだけ true にできる「自宅」 フラグ。 PC が有線接続のとき higher
   *  priority な信号 (GPS / WiFi) が無ければ、 ここを current に置く。 */
  is_home: 0 | 1;
  /** 場所ごとの GPS 誤差許容半径 (m)。 NULL なら global default
   *  (`workplace_match_radius_m`) を使う。 都市公園 vs オフィスビル等、
   *  場所の物理的な大きさに応じて 1〜50_000m の範囲で設定可。 */
  radius_m: number | null;
  shareable: 0 | 1;
  shared_at: string | null;
  shared_origin: string | null;
  // Hub からダウンロードした行のオーナー (NULL=自分)
  owner_user_id: string | null;
  owner_user_name: string | null;
  created_at: string;
  updated_at: string;
}
