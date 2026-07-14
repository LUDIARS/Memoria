// multi (Hub 連携) API request/response types
// Spec: spec/interface/multi.md

export interface MultiServer {
  url: string;
  label: string | null;
  jwt: string | null;             // GET 時は masked にしない (内部閉じ)
  userId: string | null;
  userName: string | null;
  role: 'user' | 'moderator' | 'admin' | null;
  connectedAt: string | null;     // UTC ISO
}

export interface MultiStatusResponse {
  servers: (MultiServer & { connected: boolean; active: boolean })[];
  primary: { connected: boolean; user: { id: string; name: string; role: string } | null };
}

export interface MultiServerRegisterRequest {
  url: string;
  label?: string;
}

export interface MultiActiveRequest {
  urls: string[];
}

export interface MultiConnectRequest {
  url: string;
}

export interface MultiConnectResponse {
  redirect_url: string;
}

export interface MultiFinishRequest {
  url: string;
  code: string;
  state: string;
}

export interface MultiDisconnectRequest {
  url?: string;
}

export type MultiShareKind =
  | 'bookmark'
  | 'dig'
  | 'dict'
  | 'implementation_note'
  | 'work_location';

export interface MultiShareRequest {
  kind: MultiShareKind;
  id: number;
}

export interface MultiShareResponse {
  ok: true;
  remote: { id: number; shared_at: string };
}

export interface MultiDownloadRequest {
  kind: MultiShareKind;
  remote_id: number;
}

export interface MultiDownloadResponse {
  ok: true;
  id: number;
  duplicate?: true;
  owner?: string;
}
