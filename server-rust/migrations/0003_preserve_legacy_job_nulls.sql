-- Legacy SQLite TEXT columns distinguish SQL NULL from JSON literal null.
-- Preserve that distinction during import/export without changing valid jobs.
ALTER TABLE jobs ALTER COLUMN params DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN result DROP NOT NULL;
