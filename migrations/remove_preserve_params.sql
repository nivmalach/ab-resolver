-- Remove preserve_params column since we always preserve URL parameters
ALTER TABLE experiments DROP COLUMN preserve_params;
