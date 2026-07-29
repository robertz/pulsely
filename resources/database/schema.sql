-- ============================================================
-- Realtime Pub/Sub SaaS (Pusher-competitor) — core schema
-- Convention: MySQL/MariaDB, binary(16) UUID primary keys
-- ============================================================

CREATE DATABASE IF NOT EXISTS pulsely
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pulsely;

-- ------------------------------------------------------------
-- accounts: the billing/owner entity (a customer of the SaaS)
-- ------------------------------------------------------------
CREATE TABLE accounts (
    id              BINARY(16)      NOT NULL PRIMARY KEY,
    email           VARCHAR(255)    NOT NULL,
    name            VARCHAR(255)    NOT NULL,
    password_hash   VARCHAR(255)    NOT NULL,
    plan_id         BINARY(16)      NULL,
    -- Grants the admin console, which can see and manage every account.
    is_admin        TINYINT(1)      NOT NULL DEFAULT 0,
    -- Gates sign-in, so an account can be suspended without deleting anything.
    is_active       TINYINT(1)      NOT NULL DEFAULT 1,
    stripe_customer_id VARCHAR(255) NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounts_email (email)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- plans: tier definitions (admin-managed, not hardcoded)
-- ------------------------------------------------------------
CREATE TABLE plans (
    id                      BINARY(16)     NOT NULL PRIMARY KEY,
    name                    VARCHAR(100)   NOT NULL,
    connection_limit        INT UNSIGNED  NOT NULL,
    message_daily_limit     BIGINT UNSIGNED NOT NULL,
    price_cents             INT UNSIGNED  NOT NULL DEFAULT 0,
    allows_private_channels TINYINT(1)    NOT NULL DEFAULT 0,
    allows_presence_channels TINYINT(1)   NOT NULL DEFAULT 0,
    allows_message_history  TINYINT(1)    NOT NULL DEFAULT 0,
    history_retention_hours INT UNSIGNED  NOT NULL DEFAULT 0,
    is_active                TINYINT(1)   NOT NULL DEFAULT 1,
    created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_plans_name (name)
) ENGINE=InnoDB;

ALTER TABLE accounts
    ADD CONSTRAINT fk_accounts_plan
    FOREIGN KEY (plan_id) REFERENCES plans(id);

-- ------------------------------------------------------------
-- apps: the actual product unit — one account can have many apps,
-- each app is a fully isolated pub/sub namespace with its own keys
-- ------------------------------------------------------------
CREATE TABLE apps (
    id              BINARY(16)      NOT NULL PRIMARY KEY,
    account_id      BINARY(16)      NOT NULL,
    name            VARCHAR(255)    NOT NULL,
    app_key         VARCHAR(64)     NOT NULL,   -- public, sent to client SDK
    app_secret      VARCHAR(128)    NOT NULL,   -- private, used to sign trigger API calls
    cluster         VARCHAR(50)     NOT NULL DEFAULT 'default',
    plan_id         BINARY(16)      NULL,       -- overrides account default plan if set
    is_active       TINYINT(1)      NOT NULL DEFAULT 1,
    -- Client-to-client publishing. Off by default: the app key is public, so this
    -- must be a deliberate choice per app.
    allows_client_events TINYINT(1)  NOT NULL DEFAULT 0,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_apps_app_key (app_key),
    KEY idx_apps_account (account_id),
    CONSTRAINT fk_apps_account FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_apps_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- channel_auth_rules: authorization rules for private/presence
-- channels, evaluated by the authorize() hook (pattern-based)
-- ------------------------------------------------------------
CREATE TABLE channel_auth_rules (
    id              BINARY(16)      NOT NULL PRIMARY KEY,
    app_id          BINARY(16)      NOT NULL,
    channel_pattern VARCHAR(255)    NOT NULL,   -- e.g. 'private-order-*'
    rule_type       ENUM('private','presence') NOT NULL,
    auth_webhook_url VARCHAR(500)   NULL,       -- customer's own auth endpoint, Pusher-style
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- One rule per pattern per app: duplicates would authorize non-deterministically.
    UNIQUE KEY uq_car_app_pattern (app_id, channel_pattern),
    KEY idx_car_app (app_id),
    CONSTRAINT fk_car_app FOREIGN KEY (app_id) REFERENCES apps(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- channel_messages: optional history/replay log — the
-- differentiator vs. Pusher's lack of history. Opt-in per plan.
-- ------------------------------------------------------------
CREATE TABLE channel_messages (
    id              BINARY(16)      NOT NULL PRIMARY KEY,
    app_id          BINARY(16)      NOT NULL,
    channel_name    VARCHAR(255)    NOT NULL,
    event_name      VARCHAR(255)    NOT NULL,
    payload         JSON            NOT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_cm_app_channel_created (app_id, channel_name, created_at),
    CONSTRAINT fk_cm_app FOREIGN KEY (app_id) REFERENCES apps(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- app_webhooks / webhook_deliveries: outbound event webhooks.
-- Delivery is queued so a slow customer endpoint cannot stall the broker.
-- ------------------------------------------------------------
CREATE TABLE app_webhooks (
    id              BINARY(16)      NOT NULL PRIMARY KEY,
    app_id          BINARY(16)      NOT NULL,
    url             VARCHAR(500)    NOT NULL,
    -- Comma-separated event types this endpoint wants, e.g.
    -- 'channel_occupied,channel_vacated,member_added,member_removed'
    events          VARCHAR(500)    NOT NULL DEFAULT '',
    is_active       TINYINT(1)      NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_webhook_app_url (app_id, url),
    KEY idx_webhook_app (app_id),
    CONSTRAINT fk_webhook_app FOREIGN KEY (app_id) REFERENCES apps(id)
) ENGINE=InnoDB;

CREATE TABLE webhook_deliveries (
    id              BINARY(16)      NOT NULL PRIMARY KEY,
    webhook_id      BINARY(16)      NOT NULL,
    app_id          BINARY(16)      NOT NULL,
    event_type      VARCHAR(100)    NOT NULL,
    payload         JSON            NOT NULL,
    attempts        INT UNSIGNED    NOT NULL DEFAULT 0,
    -- NULL once delivered; otherwise when the next attempt becomes due.
    next_attempt_at DATETIME        NULL,
    delivered_at    DATETIME        NULL,
    last_status     INT             NULL,
    last_error      VARCHAR(500)    NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_delivery_pending (next_attempt_at, delivered_at),
    KEY idx_delivery_app (app_id, created_at),
    CONSTRAINT fk_delivery_webhook FOREIGN KEY (webhook_id) REFERENCES app_webhooks(id) ON DELETE CASCADE,
    CONSTRAINT fk_delivery_app FOREIGN KEY (app_id) REFERENCES apps(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- usage_daily: per-app, per-day counters — feeds billing and
-- the dashboard usage graphs. Written to by the metering hooks
-- on trigger-API SEND and STOMP CONNECT/DISCONNECT.
-- ------------------------------------------------------------
CREATE TABLE usage_daily (
    id                  BINARY(16)     NOT NULL PRIMARY KEY,
    app_id              BINARY(16)     NOT NULL,
    usage_date          DATE           NOT NULL,
    messages_sent        BIGINT UNSIGNED NOT NULL DEFAULT 0,
    peak_connections      INT UNSIGNED  NOT NULL DEFAULT 0,
    connection_seconds    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_usage_app_date (app_id, usage_date),
    CONSTRAINT fk_usage_app FOREIGN KEY (app_id) REFERENCES apps(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Seed a couple of default plans so accounts have something
-- to reference on signup
-- ------------------------------------------------------------
INSERT INTO plans (id, name, connection_limit, message_daily_limit, price_cents,
                    allows_private_channels, allows_presence_channels,
                    allows_message_history, history_retention_hours)
VALUES
    (UNHEX(REPLACE(UUID(), '-', '')), 'Sandbox', 100, 200000, 0, 0, 0, 0, 0),
    (UNHEX(REPLACE(UUID(), '-', '')), 'Startup', 500, 1000000, 4900, 1, 0, 0, 0),
    (UNHEX(REPLACE(UUID(), '-', '')), 'Business', 2000, 4000000, 9900, 1, 1, 1, 24);
