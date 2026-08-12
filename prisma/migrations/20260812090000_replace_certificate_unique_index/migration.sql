-- The legacy uniqueness was created as an index, not a table constraint.
-- Remove it so the partial active-only index from the lifecycle migration
-- can permit a new active certificate while retaining revoked history.
DROP INDEX IF EXISTS "certificates_user_id_course_id_key";
