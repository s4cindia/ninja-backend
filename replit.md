# Ninja Platform Backend

## Project Overview
Ninja is an accessibility and compliance validation SaaS platform for educational publishers. It validates EPUB, PDF, and HTML content against WCAG 2.1, Section 508, and European Accessibility Act standards, generating VPATs and ACRs for government/institutional sales.

## Tech Stack
- Runtime: Node.js 20+
- Language: TypeScript 5.x (strict mode)
- Framework: Express 4.x
- Database: PostgreSQL (Prisma ORM)
- Queue: BullMQ with Redis
- Validation: Zod schemas
- AI: Google Gemini API

## Project Structure
```
src/
├── index.ts              # Application entry point
├── config/               # Environment configuration
├── routes/               # API route definitions
├── controllers/          # Request handlers
├── services/             # Business logic
├── middleware/           # Express middleware
├── models/               # Prisma models
├── queues/               # BullMQ job queues
├── workers/              # Background job processors
└── utils/                # Utility functions
```

## Critical Rules
1. NEVER commit secrets to Git
2. NEVER run DROP TABLE or DROP DATABASE
3. NEVER modify schema without approval
4. NEVER use Replit Agent for features - use approved Sprint Prompts only
5. Use ES Modules (import/export)
6. Use async/await for all async operations
7. Validate all inputs with Zod schemas

## API Conventions
- Base path: /api/v1/
- Use kebab-case for URLs
- Return standardized error responses
- Include request ID in all responses

## Database Commands
- Generate client: npx prisma generate
- Run migrations: npx prisma migrate dev
- View data: npx prisma studio

## Recovery Commands
If the Repl gets stuck:
- Restart: kill 1
- Clear cache: rm -rf node_modules/.cache
- Reinstall: rm -rf node_modules && npm install

## Development Workflow
1. Use approved Sprint Prompts from docs/sprint-prompts/
2. For debugging, use Claude Code (not Replit Agent)
3. Create feature branches: git checkout -b feat/NINJA-XXX-description
4. Commit with conventional prefixes: feat, fix, docs, chore, etc.
