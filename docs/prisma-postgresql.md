# Prisma PostgreSQL Workflow

## Environment

Copy `.env.example` to `.env` and set `DATABASE_URL` to a PostgreSQL database.

Local example:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/eduai?schema=public"
```

## Commands

Generate Prisma client:

```bash
npm run prisma:generate
```

Create and apply a local migration:

```bash
npm run prisma:migrate:dev -- --name init
```

Apply existing migrations in staging or production:

```bash
npm run prisma:migrate:deploy
```

Open Prisma Studio:

```bash
npm run prisma:studio
```

## Rules

- Use PostgreSQL for local, staging, and production.
- Do not edit production databases manually.
- Add schema models in the dedicated feature schema tasks.
