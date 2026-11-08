-- Legacy imported tasks retain an empty fingerprint; all new author tasks
-- protect request-key reuse against differing input, matching image/video jobs.
ALTER TABLE author_tasks ADD COLUMN IF NOT EXISTS fingerprint TEXT NOT NULL DEFAULT '';
