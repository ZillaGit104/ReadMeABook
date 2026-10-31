ALTER TABLE "users"
ADD COLUMN "notify_request_pending_approval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notify_request_approved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notify_request_grabbed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notify_request_available" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_request_error" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notify_request_cancelled" BOOLEAN NOT NULL DEFAULT false;
