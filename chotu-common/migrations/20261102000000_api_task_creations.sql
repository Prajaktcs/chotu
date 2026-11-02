-- The task each app `POST /v1/tasks` request created, written in the same
-- transaction as the task. A retry after a restart (whose pending
-- api_write_requests claim was released) returns that task instead of
-- creating a second one (see docs/app-api.md).
CREATE TABLE IF NOT EXISTS api_task_creations (
    member_id TEXT NOT NULL,
    request_id TEXT NOT NULL,              -- the request's `Idempotency-Key`
    task_id TEXT NOT NULL,                 -- tasks.id (no FK: the tasks table is rebuilt by legacy repairs)
    created_at TEXT NOT NULL,
    PRIMARY KEY (member_id, request_id)
);
