// dictionary domain — dictionary_entries / dictionary_links
// Spec: spec/db/dictionary.md

export interface DictionaryEntryRow {
  id: number;
  term: string;             // unique
  definition: string | null;
  notes: string | null;
  created_at: string;       // UTC ISO
  updated_at: string;       // UTC ISO
  // multi-server (Hub) 連携
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
}

export type DictionaryLinkSourceKind = 'cloud' | 'dig' | 'bookmark';

export interface DictionaryLinkRow {
  entry_id: number;
  source_kind: DictionaryLinkSourceKind;
  source_id: number;
  added_at: string;
}
