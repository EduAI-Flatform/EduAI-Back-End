-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('local', 'google');

-- AlterTable
ALTER TABLE "users"
    ALTER COLUMN "password_hash" DROP NOT NULL,
    ADD COLUMN "firebase_uid" TEXT,
    ADD COLUMN "auth_provider" "AuthProvider" NOT NULL DEFAULT 'local',
    ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");
