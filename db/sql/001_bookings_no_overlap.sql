-- Double-booking is prevented by the database, not by application code.
-- Two overlapping requests may both sit as 'pending' — that is correct, the owner
-- should see the clash and choose. The constraint only fires on approval, so
-- approving the second one raises 23P01, which the action turns into a friendly
-- "those dates were taken while you were deciding".
--
-- Idempotent: safe to run on every deploy.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap'
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING gist (
        house_id WITH =,
        daterange(start_date, end_date, '[)') WITH &&
      ) WHERE (status = 'confirmed');
  END IF;
END
$$;
