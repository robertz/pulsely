-- Development seed: one account, one app on the Business plan (history enabled),
-- and one auth rule for private channels. Idempotent.
USE pulsely;

SET @account_id = UNHEX('11111111111111111111111111111111');
SET @app_id     = UNHEX('22222222222222222222222222222222');
SET @rule_id    = UNHEX('33333333333333333333333333333333');
SET @business   = (SELECT id FROM plans WHERE name = 'Business');

-- Dev login: dev@example.com / pulsely   (PBKDF2-HMAC-SHA256, 210k iterations)
SET @pw = 'pbkdf2$210000$1ca174a3ae02bc4b1b6e568de2b7bfbc$7fb0bfa64eec075e56aada501c6eb2ef47dcc3849eb5d9eade88485129112f53';

INSERT INTO accounts (id, email, name, password_hash, plan_id)
VALUES (@account_id, 'dev@example.com', 'Dev Account', @pw, @business)
ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id), password_hash = VALUES(password_hash);

INSERT INTO apps (id, account_id, name, app_key, app_secret)
VALUES (@app_id, @account_id, 'Dev App', 'devkey123', 'devsecret456')
ON DUPLICATE KEY UPDATE app_secret = VALUES(app_secret);

INSERT INTO channel_auth_rules (id, app_id, channel_pattern, rule_type, auth_webhook_url)
VALUES (@rule_id, @app_id, 'private-*', 'private', 'http://127.0.0.1:8080/dev-auth')
ON DUPLICATE KEY UPDATE auth_webhook_url = VALUES(auth_webhook_url);

-- A second tenant, so cross-account isolation is testable rather than assumed.
SET @other_account = UNHEX('44444444444444444444444444444444');
SET @other_app     = UNHEX('55555555555555555555555555555555');
SET @sandbox       = (SELECT id FROM plans WHERE name = 'Sandbox');

INSERT INTO accounts (id, email, name, password_hash, plan_id)
VALUES (@other_account, 'other@example.com', 'Other Account', @pw, @sandbox)
ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id), password_hash = VALUES(password_hash);

INSERT INTO apps (id, account_id, name, app_key, app_secret)
VALUES (@other_app, @other_account, 'Other App', 'otherkey789', 'othersecret789')
ON DUPLICATE KEY UPDATE app_secret = VALUES(app_secret);

SELECT LOWER(HEX(id)) AS app_id, app_key, app_secret FROM apps WHERE id = @app_id;
