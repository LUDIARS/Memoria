// attendance domain — attendance_events
//
// 出席チェックイン (Aedilis 会場ゲートウェイ → Aedilis cloud → Memoria) を
// 「在席ログ (presence) の 1 種」 としてローカル SQLite に記録する。
// 個人データは userId アンカーのみ ([[project_personal_data_rule]]): 氏名等の
// 生 PII は保持しない。 facilityId / checkedInAt / reservationId のみ。
// 契約書: E:\Document\Ars\Aedilis\checkin-spike\CONTRACTS.md §5

export type AttendanceEventType = 'attendance.checked_in';

export interface AttendanceEventRow {
  id: number;
  user_id: string;          // Cernere sub (個人アンカー)
  facility_id: string;      // = attestation.placeId
  checked_in_at: number;    // epoch ms (= attestation.issuedAt / ゲートウェイ時計)
  reservation_id: string | null; // 照合できた予約。 walk-in は null
  source: string;           // 送信元 (既定 'aedilis')
  event_type: AttendanceEventType;
  ingested_at: string;      // UTC ISO (Memoria 受信時刻)
}
