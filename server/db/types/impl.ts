// implementation_notes domain
// Spec: spec/data/impl.md

export type ImplementationAttachmentType =
  | ''
  | 'github'
  | 'article'
  | 'screenshot'
  | 'video'
  | 'code'
  | 'other';

export interface ImplementationNoteRow {
  id: number;
  product: string;
  title: string;
  good_points: string | null;
  bad_points: string | null;
  attachment_type: ImplementationAttachmentType | null;
  attachment_value: string | null;
  shareable: 0 | 1;
  shared_at: string | null;
  shared_origin: string | null;
  created_at: string;
  updated_at: string;
}
