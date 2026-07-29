-- Enforce one rule per (app, pattern).
--
-- Without this, two rows with the same pattern could authorize differently from
-- one request to the next. ChannelAuthService already breaks ties deterministically
-- (longest pattern, then newest), but the constraint is the actual fix.
USE pulsely;

-- Collapse any pre-existing duplicates, keeping the newest row of each group.
DELETE r FROM channel_auth_rules r
JOIN (
    SELECT app_id, channel_pattern, MAX(created_at) AS keep_at
    FROM   channel_auth_rules
    GROUP BY app_id, channel_pattern
    HAVING COUNT(*) > 1
) dupes
  ON dupes.app_id = r.app_id
 AND dupes.channel_pattern = r.channel_pattern
 AND r.created_at < dupes.keep_at;

ALTER TABLE channel_auth_rules
    ADD CONSTRAINT uq_car_app_pattern UNIQUE (app_id, channel_pattern);
