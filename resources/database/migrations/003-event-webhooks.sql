-- Outbound event webhooks.
--
-- Two tables: the endpoints a customer registers, and a delivery queue. Delivery
-- is queued rather than inline because a customer endpoint that hangs must never
-- stall the broker thread that produced the event.
USE pulsely;

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
