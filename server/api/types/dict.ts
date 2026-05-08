// dict (dictionary + stopwords) API request/response types
// Spec: spec/api/dict.md

import type { DictionaryEntryRow, DictionaryLinkSourceKind } from '../../db/types/dictionary.js';
import type { UserStopwordRow } from '../../db/types/stopwords.js';

export interface DictionaryListResponse {
  items: DictionaryEntryRow[];
}

export interface DictionaryCreateRequest {
  term: string;
  definition?: string | null;
  notes?: string | null;
}

export interface DictionaryUpdateRequest {
  term?: string;
  definition?: string | null;
  notes?: string | null;
}

export interface DictionaryLinkRequest {
  source_kind: DictionaryLinkSourceKind;
  source_id: number;
}

export interface UpsertFromSourceRequest {
  source_kind: DictionaryLinkSourceKind;
  source_id: number;
  term: string;
  definition?: string | null;
  notes?: string | null;
}

export interface StopwordsListResponse {
  items: UserStopwordRow[];
}

export interface StopwordCreateRequest {
  word: string;
}
