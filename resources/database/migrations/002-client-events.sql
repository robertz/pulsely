-- Opt-in client-to-client publishing, off by default.
--
-- The app key is public and ships in every frontend bundle, so any browser can
-- open a connection. Client publishing is therefore off unless an app explicitly
-- turns it on, and even then it is confined to authorized private/presence
-- channels (see WebSocket.bx::authorize).
USE pulsely;

ALTER TABLE apps
    ADD COLUMN allows_client_events TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;
