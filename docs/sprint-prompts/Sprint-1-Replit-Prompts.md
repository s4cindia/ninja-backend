# Sprint 1 Replit Prompts
## Replit Development Foundation

**Version:** 3.0 - VPAT/ACR Compliance Focus  
**Sprint Duration:** Weeks 1-2 (November 22 - December 6, 2025)  
**Total Story Points:** 62

---

## Sprint 1 Technical Standards

Before executing any prompt in this sprint, ensure these standards are followed consistently:

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **API Framework** | Express 4.x |
| **Module System** | ES Modules (import/export) |
| **Validation** | Zod schemas |
| **ORM** | Prisma |
| **Async Pattern** | async/await (no callbacks) |
| **File Naming** | kebab-case for files, PascalCase for classes/interfaces |
| **Base Path** | All code in `src/` |
| **Testing** | Jest with TypeScript |
| **Frontend** | React 18+ with Vite |
| **Styling** | Tailwind CSS + Radix UI |

**Note:** Sprint 1 focuses on Replit-based development. AWS infrastructure deployment moves to Sprint 2 when DevOps engineer joins December 15.

---

## Epic 1.1: Replit Environment Setup

### Prompt US-1.1.1: Replit Workspace Configuration

#### Context
We're building the Ninja Platform, an accessibility validation SaaS for educational publishers. This is the first prompt of the project, establishing the Replit development environment that the team will use for collaborative development.

#### Prerequisites
- Replit Teams subscription is active
- Team members have Replit accounts

#### Current State
Starting fresh - no existing code.

#### Objective
Configure a Replit workspace with Node.js runtime, PostgreSQL database, and proper environment variable setup for team collaboration.

#### Technical Requirements

**Configure `.replit` file:**

```toml
run = "npm run dev"
entrypoint = "src/index.ts"

[nix]
channel = "stable-23_11"

[env]
NODE_ENV = "development"

[languages.typescript]
pattern = "**/{*.ts,*.tsx}"
syntax = "typescript"

[packager]
language = "nodejs"

[packager.features]
enabledForHosting = false
packageSearch = true
guessImports = true
```

**Configure `replit.nix`:**

```nix
{ pkgs }: {
  deps = [
    pkgs.nodejs_18
    pkgs.nodePackages.typescript
    pkgs.nodePackages.typescript-language-server
    pkgs.postgresql
  ];
}
```

**Initialize project structure:**

```
ninja-platform/
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ index.ts              # Application entry point
â”‚   â”œâ”€â”€ config/
â”‚   â”‚   â””â”€â”€ index.ts          # Environment configuration
â”‚   â”œâ”€â”€ routes/
â”‚   â”œâ”€â”€ controllers/
â”‚   â”œâ”€â”€ services/
â”‚   â”œâ”€â”€ middleware/
â”‚   â”œâ”€â”€ models/
â”‚   â””â”€â”€ utils/
â”œâ”€â”€ prisma/
â”‚   â””â”€â”€ schema.prisma
â”œâ”€â”€ tests/
â”œâ”€â”€ .env.example
â”œâ”€â”€ .gitignore
â”œâ”€â”€ package.json
â”œâ”€â”€ tsconfig.json
â””â”€â”€ README.md
```

**Create `package.json` with dependencies:**

```json
{
  "name": "ninja-platform",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "jest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev"
  },
  "dependencies": {
    "express": "^4.18.2",
    "prisma": "^5.7.0",
    "@prisma/client": "^5.7.0",
    "zod": "^3.22.4",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3",
    "uuid": "^9.0.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.0",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/bcryptjs": "^2.4.6",
    "@types/uuid": "^9.0.7",
    "typescript": "^5.3.0",
    "tsx": "^4.6.0",
    "jest": "^29.7.0",
    "@types/jest": "^29.5.11",
    "ts-jest": "^29.1.1"
  }
}
```

**Configure environment variables in Replit Secrets:**

- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: Random 64-character string for JWT signing
- `NODE_ENV`: "development"

#### Acceptance Criteria
- [ ] Given Replit Teams is provisioned
- [ ] When the workspace is created
- [ ] Then Node.js 18+ runtime is available
- [ ] And PostgreSQL database is accessible
- [ ] And environment variables are configured
- [ ] And team members can collaborate in real-time

#### Implementation Notes
- Use Replit's built-in PostgreSQL or connect to external instance
- Enable multiplayer collaboration in Replit settings
- Store all secrets in Replit Secrets, not in code
- Verify workspace runs with `npm run dev`

---

### Prompt US-1.1.2: Database Schema Definition (Prisma)

#### Context
Building on the configured Replit workspace, we now define the core database schema using Prisma ORM for type-safe database access.

#### Prerequisites
- US-1.1.1 (Replit Workspace Configuration) is complete
- PostgreSQL database is accessible

#### Current State
You should have:
- Replit workspace configured
- `package.json` with Prisma dependencies
- Empty `prisma/` directory

#### Objective
Define Prisma schema for core entities: User, Tenant, Job, ValidationResult, Issue with proper relationships and indexes.

#### Technical Requirements

**Create `prisma/schema.prisma`:**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id          String   @id @default(uuid())
  name        String
  slug        String   @unique
  settings    Json     @default("{}")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  users       User[]
  jobs        Job[]
  products    Product[]
}

model User {
  id          String   @id @default(uuid())
  email       String   @unique
  password    String
  firstName   String
  lastName    String
  role        UserRole @default(USER)
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  jobs        Job[]

  @@index([tenantId])
  @@index([email])
}

enum UserRole {
  ADMIN
  USER
  VIEWER
}

model Product {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  title       String
  isbn        String?
  format      DocumentFormat
  status      ComplianceStatus @default(NOT_ASSESSED)
  lastAssessedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  jobs        Job[]
  vpats       Vpat[]

  @@index([tenantId])
  @@index([status])
}

enum DocumentFormat {
  PDF
  EPUB
}

enum ComplianceStatus {
  COMPLIANT
  NEEDS_ATTENTION
  NON_COMPLIANT
  NOT_ASSESSED
}

model Job {
  id          String    @id @default(uuid())
  tenantId    String
  tenant      Tenant    @relation(fields: [tenantId], references: [id])
  userId      String
  user        User      @relation(fields: [userId], references: [id])
  productId   String?
  product     Product?  @relation(fields: [productId], references: [id])
  type        JobType
  status      JobStatus @default(QUEUED)
  priority    Int       @default(0)
  input       Json
  output      Json?
  error       String?
  progress    Int       @default(0)
  tokensUsed  Int       @default(0)
  costInr     Float     @default(0)
  startedAt   DateTime?
  completedAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  validationResults ValidationResult[]

  @@index([tenantId])
  @@index([status])
  @@index([userId])
  @@index([createdAt])
}

enum JobType {
  PDF_ACCESSIBILITY
  EPUB_ACCESSIBILITY
  VPAT_GENERATION
  ALT_TEXT_GENERATION
  METADATA_EXTRACTION
  BATCH_VALIDATION
}

enum JobStatus {
  QUEUED
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
}

model ValidationResult {
  id          String   @id @default(uuid())
  jobId       String
  job         Job      @relation(fields: [jobId], references: [id])
  standard    String   // "WCAG2.2", "PDF/UA", "Section508", etc.
  score       Float?   // 0-100
  status      String   // "pass", "fail", "partial"
  summary     Json
  createdAt   DateTime @default(now())

  issues      Issue[]

  @@index([jobId])
}

model Issue {
  id              String   @id @default(uuid())
  validationResultId String
  validationResult ValidationResult @relation(fields: [validationResultId], references: [id])
  wcagCriterion   String?  // e.g., "1.1.1", "1.3.1"
  section508Criterion String? // e.g., "E205.4", "502.3"
  severity        IssueSeverity
  title           String
  description     String
  location        Json?    // { page: 5, element: "img", xpath: "..." }
  remediation     String?
  status          IssueStatus @default(OPEN)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([validationResultId])
  @@index([severity])
}

enum IssueSeverity {
  CRITICAL
  SERIOUS
  MODERATE
  MINOR
}

enum IssueStatus {
  OPEN
  IN_PROGRESS
  RESOLVED
  WONT_FIX
}

model Vpat {
  id          String   @id @default(uuid())
  productId   String
  product     Product  @relation(fields: [productId], references: [id])
  edition     VpatEdition
  version     Int      @default(1)
  status      VpatStatus @default(DRAFT)
  content     Json
  generatedAt DateTime @default(now())
  publishedAt DateTime?
  expiresAt   DateTime?
  generatedBy String
  changeLog   String?
  previousVersionId String?

  @@unique([productId, edition, version])
  @@index([productId])
  @@index([status])
}

enum VpatEdition {
  VPAT_508
  VPAT_WCAG
  VPAT_EU
  VPAT_INT
}

enum VpatStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

model File {
  id          String   @id @default(uuid())
  tenantId    String
  filename    String
  originalName String
  mimeType    String
  size        Int
  path        String
  status      FileStatus @default(UPLOADED)
  metadata    Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId])
}

enum FileStatus {
  UPLOADED
  PROCESSING
  PROCESSED
  ERROR
}
```

**Run migrations:**

```bash
npx prisma migrate dev --name init
npx prisma generate
```

#### Acceptance Criteria
- [ ] Given Prisma is initialized in the project
- [ ] When the schema is defined
- [ ] Then User, Tenant, Job, ValidationResult, Issue models exist
- [ ] And migrations are generated and applied
- [ ] And TypeScript types are auto-generated

#### Implementation Notes
- Use UUID for all primary keys (better for distributed systems)
- Include soft delete support via `deletedAt` field
- Add composite indexes for common query patterns
- Tenant isolation is built into the schema design

---

### Prompt US-1.1.3: Git Repository Setup

#### Context
Setting up Git version control integrated with GitHub for the Ninja Platform, establishing branching strategy and workflow.

#### Prerequisites
- US-1.1.1 (Replit Workspace Configuration) is complete
- GitHub organization/account is available

#### Current State
You should have:
- Replit workspace with project structure
- Code files ready to commit

#### Objective
Configure Git repository with proper branching strategy, branch protection, and .gitignore.

#### Technical Requirements

**Create `.gitignore`:**

```gitignore
# Dependencies
node_modules/
.pnpm-store/

# Build outputs
dist/
build/
.next/

# Environment
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
logs/
*.log
npm-debug.log*

# Testing
coverage/
.nyc_output/

# Prisma
prisma/migrations/.migration_lock.toml

# Replit
.replit.nix
.cache/
```

**Initialize Git and push to GitHub:**

```bash
git init
git add .
git commit -m "feat: initial project setup"
git branch -M main
git remote add origin https://github.com/s4cindia/ninja-platform.git
git push -u origin main
```

**Create development branch:**

```bash
git checkout -b develop
git push -u origin develop
```

**Branching strategy:**

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - Feature branches (e.g., `feature/jwt-auth`)
- `bugfix/*` - Bug fix branches
- `release/*` - Release preparation branches

**Configure branch protection on GitHub:**

1. Protect `main` branch:
   - Require pull request reviews (1 reviewer)
   - Require status checks to pass
   - No direct pushes

2. Protect `develop` branch:
   - Require pull request reviews (1 reviewer)

#### Acceptance Criteria
- [ ] Given Git is initialized
- [ ] When repository is connected to GitHub
- [ ] Then main and develop branches exist
- [ ] And .gitignore excludes appropriate files
- [ ] And branch protection is configured
- [ ] And team can push via Replit Git integration

#### Implementation Notes
- Use Replit's built-in Git panel for commits
- Configure GitHub Actions in Sprint 2 (when DevOps joins)
- Use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`

---

## Epic 1.2: API Server Foundation

### Prompt US-1.2.1: Express + TypeScript API Server

#### Context
Creating the Express API server foundation that will serve as the backend for the Ninja Platform.

#### Prerequisites
- US-1.1.1 (Replit Workspace Configuration) is complete
- Dependencies installed via npm

#### Current State
You should have:
- Project structure in place
- `package.json` with Express dependencies
- TypeScript configured

#### Objective
Create Express server with TypeScript, proper middleware setup, and health check endpoint.

#### Technical Requirements

**Create `src/config/index.ts`:**

```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('âŒ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
```

**Create `src/index.ts`:**

```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { healthRouter } from './routes/health.routes.js';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.NODE_ENV === 'production' 
    ? ['https://ninja.s4carlisle.com'] 
    : ['http://localhost:5173'],
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(requestLogger);

// Routes
app.use('/api/v1/health', healthRouter);

// Error handling (must be last)
app.use(errorHandler);

// Start server
app.listen(config.PORT, () => {
  console.log(`ðŸš€ Ninja Platform API running on port ${config.PORT}`);
  console.log(`ðŸ“ Environment: ${config.NODE_ENV}`);
});

export default app;
```

**Create `src/routes/health.routes.ts`:**

```typescript
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      database: 'connected',
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/ready', async (req, res) => {
  res.json({ ready: true });
});

export { router as healthRouter };
```

**Create `src/middleware/request-logger.ts`:**

```typescript
import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });

  next();
}
```

#### Acceptance Criteria
- [ ] Given Express and dependencies are installed
- [ ] When the server starts
- [ ] Then it listens on configured PORT (default 3000)
- [ ] And GET /api/v1/health returns health status
- [ ] And database connectivity is verified
- [ ] And CORS is properly configured

#### Implementation Notes
- Use ES modules (`"type": "module"` in package.json)
- Include `.js` extension in imports for ES module compatibility
- Add `cors` and `helmet` packages if not already installed

---

### Prompt US-1.2.2: Route Structure Definition

#### Context
Defining the API route structure for all Ninja Platform endpoints following RESTful conventions.

#### Prerequisites
- US-1.2.1 (Express + TypeScript API Server) is complete

#### Current State
You should have:
- Express server running
- Health endpoint working

#### Objective
Create route structure for all API endpoints with versioning and proper organization.

#### Technical Requirements

**Create `src/routes/index.ts`:**

```typescript
import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { authRouter } from './auth.routes.js';
import { jobsRouter } from './jobs.routes.js';
import { filesRouter } from './files.routes.js';
import { accessibilityRouter } from './accessibility.routes.js';
import { vpatRouter } from './vpat.routes.js';
import { productsRouter } from './products.routes.js';

const router = Router();

// API v1 routes
router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/jobs', jobsRouter);
router.use('/files', filesRouter);
router.use('/accessibility', accessibilityRouter);
router.use('/vpat', vpatRouter);
router.use('/products', productsRouter);

export { router as apiRouter };
```

**Create stub route files:**

**`src/routes/auth.routes.ts`:**
```typescript
import { Router } from 'express';

const router = Router();

// POST /api/v1/auth/register
router.post('/register', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

// POST /api/v1/auth/login
router.post('/login', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

// POST /api/v1/auth/refresh
router.post('/refresh', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

// POST /api/v1/auth/logout
router.post('/logout', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

export { router as authRouter };
```

**`src/routes/jobs.routes.ts`:**
```typescript
import { Router } from 'express';

const router = Router();

// GET /api/v1/jobs - List jobs for tenant
// POST /api/v1/jobs - Create new job
// GET /api/v1/jobs/:id - Get job details
// GET /api/v1/jobs/:id/status - Get job status
// DELETE /api/v1/jobs/:id - Cancel job

router.get('/', (req, res) => res.status(501).json({ message: 'Not implemented' }));
router.post('/', (req, res) => res.status(501).json({ message: 'Not implemented' }));
router.get('/:id', (req, res) => res.status(501).json({ message: 'Not implemented' }));
router.get('/:id/status', (req, res) => res.status(501).json({ message: 'Not implemented' }));
router.delete('/:id', (req, res) => res.status(501).json({ message: 'Not implemented' }));

export { router as jobsRouter };
```

**Create similar stubs for:** `files.routes.ts`, `accessibility.routes.ts`, `vpat.routes.ts`, `products.routes.ts`

**Update `src/index.ts`:**

```typescript
import { apiRouter } from './routes/index.js';

// ... existing code ...

// Routes
app.use('/api/v1', apiRouter);
```

#### Acceptance Criteria
- [ ] Given route files are created
- [ ] When server starts
- [ ] Then all routes return 501 (Not Implemented) as stubs
- [ ] And routes follow RESTful conventions
- [ ] And routes are versioned (/api/v1/...)

#### Implementation Notes
- Stubs allow frontend development to proceed in parallel
- 501 status clearly indicates incomplete endpoints
- Add routes incrementally as features are implemented

---

### Prompt US-1.2.3: JWT Authentication Middleware

#### Context
Implementing JWT-based authentication for the Ninja Platform API.

#### Prerequisites
- US-1.2.1 (Express + TypeScript API Server) is complete
- US-1.1.2 (Database Schema) is complete

#### Current State
You should have:
- Express server running
- User model in Prisma schema
- Route structure defined

#### Objective
Create JWT authentication middleware and auth endpoints for login, registration, and token validation.

#### Technical Requirements

**Create `src/middleware/auth.middleware.ts`:**

```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    tenantId: string;
  };
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  tenantId: string;
}

export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header' 
      });
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;

    // Verify user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, tenantId: true, deletedAt: true }
    });

    if (!user || user.deletedAt) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'User not found or deactivated' 
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Token expired' 
      });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Invalid token' 
      });
    }
    next(error);
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Forbidden',
        message: `Required role: ${roles.join(' or ')}` 
      });
    }

    next();
  };
}
```

**Create `src/services/auth.service.ts`:**

```typescript
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { JwtPayload } from '../middleware/auth.middleware.js';

const prisma = new PrismaClient();

export class AuthService {
  async register(data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    tenantId: string;
  }) {
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email }
    });

    if (existingUser) {
      throw new Error('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(data.password, 12);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        password: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        tenantId: data.tenantId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
      }
    });

    const token = this.generateToken(user);

    return { user, token };
  }

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        deletedAt: true,
      }
    });

    if (!user || user.deletedAt) {
      throw new Error('Invalid credentials');
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    const { password: _, deletedAt: __, ...userWithoutPassword } = user;
    const token = this.generateToken(userWithoutPassword);

    return { user: userWithoutPassword, token };
  }

  generateToken(user: { id: string; email: string; role: string; tenantId: string }) {
    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    return jwt.sign(payload, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
    });
  }
}

export const authService = new AuthService();
```

**Update `src/routes/auth.routes.ts`:**

```typescript
import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  tenantId: z.string().uuid(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const result = await authService.register(data);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await authService.login(email, password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

export { router as authRouter };
```

#### Acceptance Criteria
- [ ] Given valid credentials
- [ ] When POST /api/v1/auth/login is called
- [ ] Then JWT token is returned
- [ ] And token contains user ID, email, role, tenantId
- [ ] And protected routes require valid token
- [ ] And expired tokens are rejected

#### Implementation Notes
- Use bcryptjs for password hashing (12 rounds)
- JWT expiry default is 7 days
- Include tenant isolation in token payload
- Never return password hash in responses

---

### Prompt US-1.2.4: Error Handling Middleware

#### Context
Creating centralized error handling for consistent API error responses.

#### Prerequisites
- US-1.2.1 (Express + TypeScript API Server) is complete

#### Current State
You should have:
- Express server running
- Basic route structure

#### Objective
Create error handling middleware that catches all errors and returns consistent JSON error responses.

#### Technical Requirements

**Create `src/utils/errors.ts`:**

```typescript
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  public readonly errors: Record<string, string[]>;

  constructor(message: string, errors: Record<string, string[]> = {}) {
    super(message, 400, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}
```

**Create `src/middleware/error-handler.ts`:**

```typescript
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, ValidationError } from '../utils/errors.js';
import { config } from '../config/index.js';
import { Prisma } from '@prisma/client';

interface ErrorResponse {
  error: string;
  code: string;
  message: string;
  errors?: Record<string, string[]>;
  stack?: string;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('Error:', err);

  // Default error response
  let statusCode = 500;
  let response: ErrorResponse = {
    error: 'Internal Server Error',
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  };

  // Handle AppError instances
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    response = {
      error: err.name,
      code: err.code,
      message: err.message,
    };

    if (err instanceof ValidationError) {
      response.errors = err.errors;
    }
  }

  // Handle Zod validation errors
  else if (err instanceof ZodError) {
    statusCode = 400;
    const errors: Record<string, string[]> = {};

    err.errors.forEach((e) => {
      const path = e.path.join('.');
      if (!errors[path]) {
        errors[path] = [];
      }
      errors[path].push(e.message);
    });

    response = {
      error: 'Validation Error',
      code: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      errors,
    };
  }

  // Handle Prisma errors
  else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      statusCode = 409;
      response = {
        error: 'Conflict',
        code: 'DUPLICATE_ENTRY',
        message: 'A record with this value already exists',
      };
    } else if (err.code === 'P2025') {
      statusCode = 404;
      response = {
        error: 'Not Found',
        code: 'NOT_FOUND',
        message: 'Record not found',
      };
    }
  }

  // Include stack trace in development
  if (config.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
```

#### Acceptance Criteria
- [ ] Given any error occurs in the application
- [ ] When error propagates to middleware
- [ ] Then consistent JSON error response is returned
- [ ] And appropriate HTTP status code is set
- [ ] And Zod validation errors are formatted nicely
- [ ] And Prisma errors are handled appropriately
- [ ] And stack traces are only shown in development

#### Implementation Notes
- All route handlers should use try/catch and call next(error)
- Log all errors for debugging
- Never expose internal error details in production

---

### Prompt US-1.2.5: Request Validation (Zod)

#### Context
Implementing request validation using Zod schemas for type-safe input validation.

#### Prerequisites
- US-1.2.4 (Error Handling Middleware) is complete

#### Current State
You should have:
- Error handling middleware
- Basic route structure

#### Objective
Create reusable validation middleware and common validation schemas.

#### Technical Requirements

**Create `src/middleware/validate.middleware.ts`:**

```typescript
import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';

export function validate(schema: AnyZodObject) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(error);
      } else {
        next(error);
      }
    }
  };
}
```

**Create `src/schemas/common.schemas.ts`:**

```typescript
import { z } from 'zod';

// Common ID parameter
export const idParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ID format'),
  }),
});

// Pagination query parameters
export const paginationSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).default('1'),
    limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

// File upload validation
export const fileUploadSchema = z.object({
  body: z.object({
    filename: z.string().min(1),
    mimeType: z.enum([
      'application/pdf',
      'application/epub+zip',
    ]),
  }),
});
```

**Create `src/schemas/job.schemas.ts`:**

```typescript
import { z } from 'zod';

export const createJobSchema = z.object({
  body: z.object({
    type: z.enum([
      'PDF_ACCESSIBILITY',
      'EPUB_ACCESSIBILITY',
      'VPAT_GENERATION',
      'ALT_TEXT_GENERATION',
      'METADATA_EXTRACTION',
      'BATCH_VALIDATION',
    ]),
    fileId: z.string().uuid(),
    productId: z.string().uuid().optional(),
    options: z.record(z.unknown()).optional(),
    priority: z.number().int().min(0).max(10).default(0),
  }),
});

export const updateJobSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    status: z.enum(['CANCELLED']).optional(),
  }),
});

export const listJobsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional().default('1'),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default('20'),
    status: z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
    type: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }),
});
```

**Usage example in routes:**

```typescript
import { validate } from '../middleware/validate.middleware.js';
import { createJobSchema, listJobsSchema } from '../schemas/job.schemas.js';

router.get('/', validate(listJobsSchema), async (req, res, next) => {
  // req.query is now typed and validated
});

router.post('/', validate(createJobSchema), async (req, res, next) => {
  // req.body is now typed and validated
});
```

#### Acceptance Criteria
- [ ] Given a request is received
- [ ] When validation middleware runs
- [ ] Then body, query, and params are validated against schema
- [ ] And invalid requests return 400 with detailed errors
- [ ] And valid requests proceed to handler
- [ ] And TypeScript types are inferred from schemas

#### Implementation Notes
- Use Zod's `.transform()` for type coercion (string to number)
- Create reusable schemas for common patterns
- Validation errors are formatted by error handler middleware

---

## Epic 1.3: File Upload & Storage

### Prompt US-1.3.1: Local File Upload (Replit)

#### Context
Implementing file upload functionality for PDF and EPUB documents, storing in Replit's persistent storage.

#### Prerequisites
- US-1.2.3 (JWT Authentication) is complete
- US-1.2.5 (Request Validation) is complete

#### Current State
You should have:
- Authentication middleware working
- Validation middleware working

#### Objective
Create file upload endpoint that accepts PDF/EPUB files and stores them in Replit's persistent storage.

#### Technical Requirements

**Install multer:**
```bash
npm install multer @types/multer
```

**Create `src/middleware/upload.middleware.ts`:**

```typescript
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from './auth.middleware.js';

const UPLOAD_DIR = process.env.REPLIT_DB_DIR 
  ? path.join(process.env.REPLIT_DB_DIR, 'uploads')
  : path.join(process.cwd(), 'data', 'uploads');

const storage = multer.diskStorage({
  destination: (req: AuthenticatedRequest, file, cb) => {
    const tenantDir = path.join(UPLOAD_DIR, req.user?.tenantId || 'default');

    // Create directory if it doesn't exist
    import('fs').then(fs => {
      fs.mkdirSync(tenantDir, { recursive: true });
      cb(null, tenantDir);
    });
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${uuidv4()}${ext}`;
    cb(null, filename);
  },
});

const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedMimes = [
    'application/pdf',
    'application/epub+zip',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${allowedMimes.join(', ')}`));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});
```

**Create `src/services/file.service.ts`:**

```typescript
import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';

const prisma = new PrismaClient();

export class FileService {
  async createFile(data: {
    tenantId: string;
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    path: string;
  }) {
    return prisma.file.create({
      data: {
        tenantId: data.tenantId,
        filename: data.filename,
        originalName: data.originalName,
        mimeType: data.mimeType,
        size: data.size,
        path: data.path,
        status: 'UPLOADED',
      },
    });
  }

  async getFile(id: string, tenantId: string) {
    return prisma.file.findFirst({
      where: {
        id,
        tenantId,
      },
    });
  }

  async listFiles(tenantId: string, options: {
    page?: number;
    limit?: number;
  } = {}) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [files, total] = await Promise.all([
      prisma.file.findMany({
        where: { tenantId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.file.count({ where: { tenantId } }),
    ]);

    return {
      files,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async deleteFile(id: string, tenantId: string) {
    const file = await this.getFile(id, tenantId);

    if (!file) {
      throw new Error('File not found');
    }

    // Delete physical file
    await fs.unlink(file.path).catch(() => {});

    // Delete database record
    await prisma.file.delete({ where: { id } });

    return file;
  }
}

export const fileService = new FileService();
```

**Update `src/routes/files.routes.ts`:**

```typescript
import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { upload } from '../middleware/upload.middleware.js';
import { fileService } from '../services/file.service.js';

const router = Router();

router.use(authenticate);

router.post('/upload', upload.single('file'), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = await fileService.createFile({
      tenantId: req.user!.tenantId,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
    });

    res.status(201).json({
      id: file.id,
      filename: file.originalName,
      size: file.size,
      mimeType: file.mimeType,
      uploadedAt: file.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req: AuthenticatedRequest, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await fileService.listFiles(req.user!.tenantId, { page, limit });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: AuthenticatedRequest, res, next) => {
  try {
    const file = await fileService.getFile(req.params.id, req.user!.tenantId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json(file);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res, next) => {
  try {
    await fileService.deleteFile(req.params.id, req.user!.tenantId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { router as filesRouter };
```

#### Acceptance Criteria
- [ ] Given I am authenticated
- [ ] When I upload a file via POST /api/v1/files/upload
- [ ] Then file is validated (type: PDF/EPUB, size: max 100MB)
- [ ] And file is stored in Replit persistent storage
- [ ] And file metadata is saved to database
- [ ] And file ID is returned for reference

#### Implementation Notes
- Use Replit's persistent storage (`/home/runner/data/uploads/`)
- Organize files by tenant ID for isolation
- Generate UUID filenames to prevent conflicts
- Store original filename in database

---

### Prompt US-1.3.2: File Metadata Service

#### Context
Extending file handling with metadata extraction and tracking.

#### Prerequisites
- US-1.3.1 (Local File Upload) is complete

#### Current State
You should have:
- File upload working
- Files stored in persistent storage

#### Objective
Create file metadata service that tracks file information and status.

#### Technical Requirements

**Update `src/services/file.service.ts`** to add metadata methods:

```typescript
async updateFileStatus(id: string, status: FileStatus, metadata?: Record<string, unknown>) {
  return prisma.file.update({
    where: { id },
    data: {
      status,
      metadata: metadata ? metadata : undefined,
      updatedAt: new Date(),
    },
  });
}

async updateFileMetadata(id: string, metadata: Record<string, unknown>) {
  const file = await prisma.file.findUnique({ where: { id } });

  if (!file) {
    throw new Error('File not found');
  }

  const existingMetadata = (file.metadata as Record<string, unknown>) || {};

  return prisma.file.update({
    where: { id },
    data: {
      metadata: { ...existingMetadata, ...metadata },
      updatedAt: new Date(),
    },
  });
}

async getFilesByStatus(tenantId: string, status: FileStatus) {
  return prisma.file.findMany({
    where: { tenantId, status },
    orderBy: { createdAt: 'desc' },
  });
}
```

#### Acceptance Criteria
- [ ] Given a file is uploaded
- [ ] When metadata is extracted
- [ ] Then filename, size, MIME type, upload date, uploader are stored
- [ ] And files are queryable by tenant
- [ ] And file status is tracked (uploaded, processing, completed)

#### Implementation Notes
- Use JSON field for flexible metadata storage
- Status transitions: UPLOADED â†’ PROCESSING â†’ PROCESSED/ERROR
- Add indexes for efficient status queries

---

## Epic 1.4: Frontend Foundation

### Prompt US-1.4.1: React + Vite Project Setup

#### Context
Creating the React frontend application for the Ninja Platform.

#### Prerequisites
- US-1.1.1 (Replit Workspace Configuration) is complete

#### Current State
- Backend API is running
- Need separate frontend project in Replit

#### Objective
Set up React project with Vite, TypeScript, and proper configuration.

#### Technical Requirements

**Create separate Replit workspace for frontend or subdirectory `frontend/`**

**Initialize with Vite:**

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

**Configure `frontend/vite.config.ts`:**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
```

**Configure `frontend/tsconfig.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

**Create project structure:**

```
frontend/
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ main.tsx
â”‚   â”œâ”€â”€ App.tsx
â”‚   â”œâ”€â”€ components/
â”‚   â”‚   â”œâ”€â”€ ui/           # Reusable UI components
â”‚   â”‚   â””â”€â”€ layout/       # Layout components
â”‚   â”œâ”€â”€ pages/
â”‚   â”œâ”€â”€ hooks/
â”‚   â”œâ”€â”€ services/         # API services
â”‚   â”œâ”€â”€ stores/           # State management
â”‚   â”œâ”€â”€ types/
â”‚   â””â”€â”€ utils/
â”œâ”€â”€ public/
â”œâ”€â”€ index.html
â””â”€â”€ package.json
```

#### Acceptance Criteria
- [ ] Given Node.js 18+ is available
- [ ] When the frontend project is initialized
- [ ] Then Vite is the build tool
- [ ] And TypeScript is configured with strict mode
- [ ] And development server starts on port 5173
- [ ] And hot module replacement works

#### Implementation Notes
- Use path alias `@/` for clean imports
- Configure proxy to backend API
- Add ESLint and Prettier for code quality

---

### Prompt US-1.4.2: React Router Configuration

#### Context
Setting up client-side routing for the Ninja Platform frontend.

#### Prerequisites
- US-1.4.1 (React + Vite Project Setup) is complete

#### Current State
You should have:
- React project running
- Basic App.tsx

#### Objective
Configure React Router with protected routes and layout components.

#### Technical Requirements

**Install dependencies:**

```bash
npm install react-router-dom
npm install -D @types/react-router-dom
```

**Create `src/components/layout/MainLayout.tsx`:**

```typescript
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

export function MainLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Link to="/" className="text-xl font-bold text-indigo-600">
                Ninja Platform
              </Link>
              <div className="ml-10 flex space-x-4">
                <Link to="/dashboard" className="text-gray-600 hover:text-gray-900">
                  Dashboard
                </Link>
                <Link to="/jobs" className="text-gray-600 hover:text-gray-900">
                  Jobs
                </Link>
                <Link to="/products" className="text-gray-600 hover:text-gray-900">
                  Products
                </Link>
              </div>
            </div>
            <div className="flex items-center">
              <span className="text-gray-600 mr-4">{user?.email}</span>
              <button
                onClick={handleLogout}
                className="text-gray-600 hover:text-gray-900"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
```

**Create `src/components/auth/ProtectedRoute.tsx`:**

```typescript
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
```

**Update `src/App.tsx`:**

```typescript
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/contexts/AuthContext';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { MainLayout } from '@/components/layout/MainLayout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { JobsPage } from '@/pages/JobsPage';
import { ProductsPage } from '@/pages/ProductsPage';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <MainLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="jobs" element={<JobsPage />} />
              <Route path="products" element={<ProductsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
```

#### Acceptance Criteria
- [ ] Given React Router is configured
- [ ] When user navigates between pages
- [ ] Then URL updates correctly
- [ ] And protected routes redirect to login when unauthenticated
- [ ] And navigation state is preserved

#### Implementation Notes
- Use React Router v6 syntax
- Implement lazy loading for route components later
- Store auth state in context

---

### Prompt US-1.4.3: TanStack Query Setup

#### Context
Setting up TanStack Query (React Query) for server state management.

#### Prerequisites
- US-1.4.1 (React + Vite Project Setup) is complete

#### Current State
You should have:
- React project with routing

#### Objective
Configure TanStack Query for API data fetching with caching and synchronization.

#### Technical Requirements

**Install dependencies:**

```bash
npm install @tanstack/react-query axios
```

**Create `src/services/api.ts`:**

```typescript
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);
```

**Create `src/hooks/useJobs.ts`:**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

interface Job {
  id: string;
  type: string;
  status: string;
  progress: number;
  createdAt: string;
}

interface JobsResponse {
  jobs: Job[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export function useJobs(options: { page?: number; status?: string } = {}) {
  return useQuery({
    queryKey: ['jobs', options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options.page) params.set('page', String(options.page));
      if (options.status) params.set('status', options.status);

      const { data } = await api.get<JobsResponse>(`/jobs?${params}`);
      return data;
    },
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: ['jobs', id],
    queryFn: async () => {
      const { data } = await api.get<Job>(`/jobs/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (jobData: { type: string; fileId: string; options?: Record<string, unknown> }) => {
      const { data } = await api.post<Job>('/jobs', jobData);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
```

#### Acceptance Criteria
- [ ] Given TanStack Query is configured
- [ ] When API calls are made
- [ ] Then responses are cached appropriately
- [ ] And loading/error states are available
- [ ] And mutations invalidate relevant queries

#### Implementation Notes
- Configure stale time and cache time per query
- Use query keys for cache invalidation
- Handle optimistic updates for better UX

---

### Prompt US-1.4.4: Tailwind CSS + Component Library

#### Context
Setting up Tailwind CSS and Radix UI for consistent styling and accessible components.

#### Prerequisites
- US-1.4.1 (React + Vite Project Setup) is complete

#### Current State
You should have:
- React project running
- Basic styling in place

#### Objective
Configure Tailwind CSS with custom theme and integrate Radix UI for accessible components.

#### Technical Requirements

**Install dependencies:**

```bash
npm install -D tailwindcss postcss autoprefixer
npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-toast @radix-ui/react-tabs
npx tailwindcss init -p
```

**Configure `tailwind.config.js`:**

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
      },
    },
  },
  plugins: [],
}
```

**Create `src/components/ui/Button.tsx`:**

```typescript
import { forwardRef, ButtonHTMLAttributes } from 'react';
import { clsx } from 'clsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading, children, disabled, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

    const variants = {
      primary: 'bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500',
      secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200 focus:ring-gray-500',
      outline: 'border border-gray-300 text-gray-700 hover:bg-gray-50 focus:ring-primary-500',
      ghost: 'text-gray-700 hover:bg-gray-100 focus:ring-gray-500',
      danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
    };

    const sizes = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-sm',
      lg: 'px-6 py-3 text-base',
    };

    return (
      <button
        ref={ref}
        className={clsx(baseStyles, variants[variant], sizes[size], className)}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && (
          <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
```

**Create additional UI components:** Input, Card, Modal, Table, Badge, etc.

#### Acceptance Criteria
- [ ] Given Tailwind CSS is configured
- [ ] When components are styled
- [ ] Then consistent design system is applied
- [ ] And Radix UI provides accessible primitives
- [ ] And dark mode can be added later

#### Implementation Notes
- Use `clsx` for conditional class names
- Follow Radix UI patterns for accessibility
- Create consistent spacing and color tokens

---

## Epic 1.5: Basic Job Queue

### Prompt US-1.5.1: BullMQ Configuration

#### Context
Setting up BullMQ for background job processing using Redis.

#### Prerequisites
- US-1.1.1 (Replit Workspace Configuration) is complete
- Redis is available (Replit add-on or external)

#### Current State
You should have:
- Express server running
- Database configured

#### Objective
Configure BullMQ with Redis connection for reliable job processing.

#### Technical Requirements

**Install dependencies:**

```bash
npm install bullmq ioredis
```

**Create `src/config/redis.ts`:**

```typescript
import { Redis } from 'ioredis';
import { config } from './index.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on('error', (error) => {
  console.error('Redis connection error:', error);
});

redisConnection.on('connect', () => {
  console.log('âœ… Redis connected');
});
```

**Create `src/queues/index.ts`:**

```typescript
import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';

// Define queue names
export const QUEUE_NAMES = {
  ACCESSIBILITY: 'accessibility',
  VPAT: 'vpat',
  METADATA: 'metadata',
} as const;

// Create queues
export const accessibilityQueue = new Queue(QUEUE_NAMES.ACCESSIBILITY, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      age: 24 * 60 * 60, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
    },
  },
});

export const vpatQueue = new Queue(QUEUE_NAMES.VPAT, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

export const metadataQueue = new Queue(QUEUE_NAMES.METADATA, {
  connection: redisConnection,
});

// Queue event logging
[accessibilityQueue, vpatQueue, metadataQueue].forEach((queue) => {
  queue.on('error', (error) => {
    console.error(`Queue ${queue.name} error:`, error);
  });
});
```

#### Acceptance Criteria
- [ ] Given Redis is available
- [ ] When BullMQ is configured
- [ ] Then queues are created for different job types
- [ ] And jobs can be added to queues
- [ ] And retry logic is configured
- [ ] And job lifecycle events are logged

#### Implementation Notes
- Use Replit's Redis add-on or external Redis
- Configure separate queues for different job types
- Set reasonable retry and cleanup policies

---

### Prompt US-1.5.2: Job Processor Framework

#### Context
Creating the worker framework that processes jobs from the queues.

#### Prerequisites
- US-1.5.1 (BullMQ Configuration) is complete

#### Current State
You should have:
- BullMQ queues configured
- Redis connection working

#### Objective
Create job processor framework with proper error handling and progress reporting.

#### Technical Requirements

**Create `src/workers/accessibility.worker.ts`:**

```typescript
import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { QUEUE_NAMES } from '../queues/index.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface AccessibilityJobData {
  jobId: string;
  fileId: string;
  type: 'PDF_ACCESSIBILITY' | 'EPUB_ACCESSIBILITY';
  options?: Record<string, unknown>;
}

async function processAccessibilityJob(job: Job<AccessibilityJobData>) {
  const { jobId, fileId, type } = job.data;

  console.log(`Processing ${type} job ${jobId} for file ${fileId}`);

  try {
    // Update job status to processing
    await prisma.job.update({
      where: { id: jobId },
      data: { 
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });

    // Report progress
    await job.updateProgress(10);

    // TODO: Implement actual processing in Sprint 3
    // For now, simulate processing
    await new Promise(resolve => setTimeout(resolve, 2000));
    await job.updateProgress(50);

    await new Promise(resolve => setTimeout(resolve, 2000));
    await job.updateProgress(100);

    // Update job status to completed
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        output: { message: 'Processing complete (stub)' },
      },
    });

    return { success: true, jobId };
  } catch (error) {
    // Update job status to failed
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    throw error;
  }
}

export const accessibilityWorker = new Worker(
  QUEUE_NAMES.ACCESSIBILITY,
  processAccessibilityJob,
  {
    connection: redisConnection,
    concurrency: 2, // Process 2 jobs at a time
  }
);

accessibilityWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

accessibilityWorker.on('failed', (job, error) => {
  console.error(`Job ${job?.id} failed:`, error);
});

accessibilityWorker.on('progress', (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});
```

**Create `src/workers/index.ts`:**

```typescript
import { accessibilityWorker } from './accessibility.worker.js';

export function startWorkers() {
  console.log('ðŸš€ Starting job workers...');

  // Workers are started when imported
  // Add any initialization logic here

  console.log('âœ… Accessibility worker started');
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down workers...');
  await accessibilityWorker.close();
  process.exit(0);
});
```

**Update `src/index.ts` to start workers:**

```typescript
import { startWorkers } from './workers/index.js';

// ... existing code ...

// Start workers
startWorkers();
```

#### Acceptance Criteria
- [ ] Given a job is added to queue
- [ ] When worker picks up job
- [ ] Then job status is updated to PROCESSING
- [ ] And progress is reported during processing
- [ ] And job status is updated to COMPLETED/FAILED
- [ ] And errors are captured and logged

#### Implementation Notes
- Set concurrency based on server resources
- Implement graceful shutdown
- Progress updates should be meaningful percentages

---

### Prompt US-1.5.3: Job Status API

#### Context
Creating API endpoints for querying job status and managing jobs.

#### Prerequisites
- US-1.5.2 (Job Processor Framework) is complete
- US-1.2.3 (JWT Authentication) is complete

#### Current State
You should have:
- Job queue and workers running
- Job model in database

#### Objective
Create REST API for job management with status polling and cancellation.

#### Technical Requirements

**Create `src/services/job.service.ts`:**

```typescript
import { PrismaClient, JobType, JobStatus } from '@prisma/client';
import { accessibilityQueue, vpatQueue, metadataQueue } from '../queues/index.js';

const prisma = new PrismaClient();

export class JobService {
  async createJob(data: {
    tenantId: string;
    userId: string;
    type: JobType;
    fileId?: string;
    productId?: string;
    options?: Record<string, unknown>;
    priority?: number;
  }) {
    const job = await prisma.job.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        type: data.type,
        productId: data.productId,
        priority: data.priority || 0,
        input: {
          fileId: data.fileId,
          options: data.options,
        },
        status: 'QUEUED',
      },
    });

    // Add to appropriate queue
    const queue = this.getQueueForType(data.type);
    await queue.add(data.type, {
      jobId: job.id,
      fileId: data.fileId,
      type: data.type,
      options: data.options,
    }, {
      priority: data.priority,
    });

    return job;
  }

  async getJobStatus(id: string, tenantId: string) {
    const job = await prisma.job.findFirst({
      where: { id, tenantId },
      include: {
        validationResults: {
          include: {
            issues: true,
          },
        },
      },
    });

    if (!job) {
      return null;
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      tokensUsed: job.tokensUsed,
      costInr: job.costInr,
      results: job.output,
      validationResults: job.validationResults,
    };
  }

  async cancelJob(id: string, tenantId: string) {
    const job = await prisma.job.findFirst({
      where: { id, tenantId },
    });

    if (!job) {
      throw new Error('Job not found');
    }

    if (job.status !== 'QUEUED' && job.status !== 'PROCESSING') {
      throw new Error('Job cannot be cancelled');
    }

    // Remove from queue if still queued
    const queue = this.getQueueForType(job.type);
    const queueJob = await queue.getJob(id);
    if (queueJob) {
      await queueJob.remove();
    }

    return prisma.job.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });
  }

  async listJobs(tenantId: string, options: {
    page?: number;
    limit?: number;
    status?: JobStatus;
    type?: JobType;
  } = {}) {
    const { page = 1, limit = 20, status, type } = options;
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(status && { status }),
      ...(type && { type }),
    };

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.job.count({ where }),
    ]);

    return {
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  private getQueueForType(type: JobType) {
    switch (type) {
      case 'PDF_ACCESSIBILITY':
      case 'EPUB_ACCESSIBILITY':
      case 'ALT_TEXT_GENERATION':
        return accessibilityQueue;
      case 'VPAT_GENERATION':
        return vpatQueue;
      case 'METADATA_EXTRACTION':
        return metadataQueue;
      default:
        return accessibilityQueue;
    }
  }
}

export const jobService = new JobService();
```

**Update `src/routes/jobs.routes.ts`:**

```typescript
import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { createJobSchema, listJobsSchema } from '../schemas/job.schemas.js';
import { jobService } from '../services/job.service.js';

const router = Router();

router.use(authenticate);

router.get('/', validate(listJobsSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await jobService.listJobs(req.user!.tenantId, {
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      status: req.query.status as any,
      type: req.query.type as any,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/', validate(createJobSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    const job = await jobService.createJob({
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      ...req.body,
    });
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: AuthenticatedRequest, res, next) => {
  try {
    const job = await jobService.getJobStatus(req.params.id, req.user!.tenantId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/status', async (req: AuthenticatedRequest, res, next) => {
  try {
    const job = await jobService.getJobStatus(req.params.id, req.user!.tenantId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
      status: job.status,
      progress: job.progress,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res, next) => {
  try {
    await jobService.cancelJob(req.params.id, req.user!.tenantId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { router as jobsRouter };
```

#### Acceptance Criteria
- [ ] Given a job exists
- [ ] When I GET /api/v1/jobs/{jobId}/status
- [ ] Then status (queued/processing/completed/failed), progress, timestamps are returned
- [ ] And completed jobs include results summary
- [ ] And jobs can be cancelled via DELETE

#### Implementation Notes
- Implement polling on frontend for job status
- Consider WebSocket for real-time updates later
- Cache job status in Redis for faster reads

---

## Sprint 1 Execution Checklist

Execute prompts in this order, verifying each is complete before proceeding:

### Week 1 (Nov 22-29)
- [ ] US-1.1.1: Replit Workspace Configuration
- [ ] US-1.1.2: Database Schema Definition (Prisma)
- [ ] US-1.1.3: Git Repository Setup
- [ ] US-1.2.1: Express + TypeScript API Server
- [ ] US-1.2.2: Route Structure Definition
- [ ] US-1.2.3: JWT Authentication Middleware
- [ ] US-1.2.4: Error Handling Middleware
- [ ] US-1.2.5: Request Validation (Zod)

### Week 2 (Nov 29 - Dec 6)
- [ ] US-1.3.1: Local File Upload (Replit)
- [ ] US-1.3.2: File Metadata Service
- [ ] US-1.4.1: React + Vite Project Setup
- [ ] US-1.4.2: React Router Configuration
- [ ] US-1.4.3: TanStack Query Setup
- [ ] US-1.4.4: Tailwind CSS + Component Library
- [ ] US-1.5.1: BullMQ Configuration
- [ ] US-1.5.2: Job Processor Framework
- [ ] US-1.5.3: Job Status API

---

## Sprint 1 Success Criteria

- âœ… Replit workspace operational with real-time collaboration
- âœ… Database schema deployed and tested
- âœ… API server running with authentication
- âœ… Frontend development environment ready
- âœ… Job queue processing test jobs successfully
- âœ… Git workflow established with branch protection

---

*End of Sprint 1 Replit Prompts*
