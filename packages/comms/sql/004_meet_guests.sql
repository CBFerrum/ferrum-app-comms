-- A room's guest link (src/meet.rs): its secret, or none while the link is off. Making a new link
-- replaces the secret, so the old link stops working.
alter table comms_meeting add column if not exists guest_key text;
