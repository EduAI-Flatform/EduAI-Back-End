DO $$
DECLARE
  legacy_index REGCLASS;
BEGIN
  FOR legacy_index IN
    SELECT index_metadata.indexrelid::REGCLASS
    FROM pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'submissions'::REGCLASS
      AND index_metadata.indisunique
      AND NOT index_metadata.indisprimary
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_metadata
        WHERE constraint_metadata.conindid = index_metadata.indexrelid
      )
      AND (
        SELECT ARRAY_AGG(attribute_metadata.attname ORDER BY index_column.ordinality)
        FROM UNNEST(index_metadata.indkey::SMALLINT[]) WITH ORDINALITY
          AS index_column(attnum, ordinality)
        JOIN pg_attribute AS attribute_metadata
          ON attribute_metadata.attrelid = index_metadata.indrelid
          AND attribute_metadata.attnum = index_column.attnum
        WHERE index_column.attnum > 0
      ) = ARRAY['assignment_id', 'user_id']::NAME[]
  LOOP
    EXECUTE FORMAT('DROP INDEX %s', legacy_index);
  END LOOP;
END
$$;
