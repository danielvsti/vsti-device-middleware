BEGIN;

ALTER TABLE safety_inspection_evidence
  DROP CONSTRAINT IF EXISTS safety_inspection_evidence_media_type;

ALTER TABLE safety_inspection_evidence
  ADD CONSTRAINT safety_inspection_evidence_media_type
  CHECK (media_type IN ('audio','image','video'));

COMMIT;
