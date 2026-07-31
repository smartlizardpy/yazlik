-- Marks a block this app created by reading an event out of Google Calendar.
--
-- `google_event_id` cannot carry this meaning: a block the owner made in the
-- app is also given an event id the moment it is pushed out to Google, so the
-- two are indistinguishable on the row. Before this column existed, deleting
-- that event in Google made the next pull remove a block the owner had made by
-- hand — silent data loss.
--
-- Idempotent: safe to run on every push, not once.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS imported_from_google boolean NOT NULL DEFAULT false;
