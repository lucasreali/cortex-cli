-- The hash of the decision file a row was derived from. Files were meant to be
-- immutable, but they are markdown on a branch: a hand edit, a merge that
-- resolved a conflict inside one, a reviewer fixing a typo — and the reconciler
-- only ever imported ids it had not seen, so the row kept the old title, body,
-- anchors, FTS entry and vector forever while edges and status were re-derived
-- from the new text. Two clones of one repository answered differently.
--
-- NULL is "derived before this column existed": the next reconcile treats it
-- as changed and rewrites the row from the file once, which is also the repair.
ALTER TABLE nodes ADD COLUMN content_sha TEXT;
