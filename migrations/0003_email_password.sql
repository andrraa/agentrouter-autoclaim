-- Preserve account IDs, enabled flags and claim history. Old accounts require new credentials.
ALTER TABLE accounts ADD COLUMN credentials TEXT;
ALTER TABLE accounts DROP COLUMN github_cookie;
