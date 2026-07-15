-- CreateTable
CREATE TABLE "library_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "file_url" TEXT,
    "external_url" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "library_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "resource_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "library_categories_slug_key" ON "library_categories"("slug");

-- CreateIndex
CREATE INDEX "library_resources_owner_id_idx" ON "library_resources"("owner_id");

-- CreateIndex
CREATE INDEX "library_resources_category_id_idx" ON "library_resources"("category_id");

-- CreateIndex
CREATE INDEX "library_resources_type_idx" ON "library_resources"("type");

-- CreateIndex
CREATE INDEX "library_resources_visibility_idx" ON "library_resources"("visibility");

-- CreateIndex
CREATE INDEX "library_resources_deleted_at_idx" ON "library_resources"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "library_tags_slug_key" ON "library_tags"("slug");

-- CreateIndex
CREATE INDEX "resource_tags_tag_id_idx" ON "resource_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_tags_resource_id_tag_id_key" ON "resource_tags"("resource_id", "tag_id");

-- CreateIndex
CREATE INDEX "saved_resources_resource_id_idx" ON "saved_resources"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_resources_user_id_resource_id_key" ON "saved_resources"("user_id", "resource_id");

-- AddForeignKey
ALTER TABLE "library_resources" ADD CONSTRAINT "library_resources_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_resources" ADD CONSTRAINT "library_resources_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "library_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_tags" ADD CONSTRAINT "resource_tags_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "library_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_tags" ADD CONSTRAINT "resource_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "library_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_resources" ADD CONSTRAINT "saved_resources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_resources" ADD CONSTRAINT "saved_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "library_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
