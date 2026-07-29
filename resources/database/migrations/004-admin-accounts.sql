-- System administrators.
--
-- is_admin grants access to the admin console, which can see and manage every
-- account. is_active gates sign-in, so an account can be suspended without
-- deleting anything.
USE pulsely;

ALTER TABLE accounts
    ADD COLUMN is_admin  TINYINT(1) NOT NULL DEFAULT 0 AFTER plan_id,
    ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER is_admin;
