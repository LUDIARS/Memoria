// impl (implementation_notes) API request/response types
// Spec: spec/api/impl.md

import type { ImplementationNoteRow, ImplementationAttachmentType } from '../../db/types/impl.js';

export interface ImplementationNoteListQuery {
  limit?: number;                 // default 100, max 200
  offset?: number;
}

export interface ImplementationNoteListResponse {
  items: ImplementationNoteRow[];
}

export interface ImplementationNoteCreateRequest {
  product?: string;
  title: string;
  good_points?: string;
  bad_points?: string;
  attachment_type?: ImplementationAttachmentType;
  attachment_value?: string;
  shareable?: boolean;
}

export interface ImplementationNoteUpdateRequest {
  product?: string;
  title?: string;
  good_points?: string | null;
  bad_points?: string | null;
  attachment_type?: ImplementationAttachmentType;
  attachment_value?: string | null;
  shareable?: boolean;
}

export interface ImplementationNoteMutationResponse {
  note: ImplementationNoteRow;
}
