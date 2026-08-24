-- PostgreSQL requires a newly added enum value to commit before later
-- migrations may use it in constraints or data.
ALTER TYPE "commerce_product_type" ADD VALUE 'membership';
