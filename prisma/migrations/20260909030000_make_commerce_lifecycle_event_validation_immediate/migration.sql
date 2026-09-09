-- Validate each append-only lifecycle event against the entity state that exists
-- at the moment the event is inserted. The entity-side require-lifecycle guards
-- remain DEFERRABLE so update + evidence can still commit atomically.
--
-- The original lifecycle-event constraint trigger was deferred until COMMIT.
-- When one transaction legitimately performed two transitions for the same
-- entity (for example fulfillment not_started -> processing -> fulfilled), the
-- first event was validated only after the entity had already reached the
-- second state and therefore failed with SQLSTATE 23514.

DROP TRIGGER IF EXISTS "commerce_lifecycle_events_validate_entity"
  ON "commerce_lifecycle_events";

CREATE TRIGGER "commerce_lifecycle_events_validate_entity"
  AFTER INSERT ON "commerce_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION "commerce_validate_lifecycle_event"();
