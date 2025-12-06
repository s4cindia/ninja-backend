# Ninja Platform Replit Setup Guide

**Version:** 2.1  
**Last Updated:** December 2025  
**Classification:** Internal Use Only

---

## 1. Introduction

This guide provides step-by-step instructions for setting up the Replit development environment for the Ninja Platform. It covers both backend and frontend project configuration.

### Prerequisites

- Replit Teams account (request access from team lead)
- GitHub account added to the s4cindia organization
- Completed the Git and GitHub Training Course

---

## 2. Initial Replit Account Setup

### Step 2.1: Accept Team Invitation

1. Check your email for Replit Teams invitation
2. Click the invitation link
3. Create account or sign in with existing Replit account
4. Verify you can see the S4Carlisle team workspace

### Step 2.2: Connect GitHub Account

1. Go to **Account Settings** → **Connected Services**
2. Click **Connect** next to GitHub
3. Authorize Replit to access your repositories
4. Verify connection shows as "Connected"

---

## 3. Backend Project Setup

### Step 3.1: Import Backend Repository

1. Click **+ Create Repl**
2. Select **Import from GitHub**
3. Enter repository URL: `https://github.com/s4cindia/ninja-backend`
4. Click **Import from GitHub**
5. Wait for the import to complete

### Step 3.2: Configure Environment Variables

Navigate to **Tools** → **Secrets** and add the following:

| Key | Description | Example Value |
|-----|-------------|---------------|
| `DATABASE_URL` | Neon PostgreSQL connection string | `postgresql://user:pass@host/db?sslmode=require` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `GEMINI_API_KEY` | Google Gemini API key | `AIza...` |
| `JWT_SECRET` | JWT signing secret | `your-secure-secret-here` |
| `NODE_ENV` | Environment mode | `development` |

### Step 3.3: Create Backend replit.md

Create a file named `replit.md` in the project root with the following content:

```markdown
# Ninja Platform Backend

## Project Overview
This is the Ninja Platform backend API - an accessibility and compliance validation service for educational publishers.

## Tech Stack
- **Runtime:** Node.js 20
- **Framework:** Express.js with TypeScript
- **Database:** PostgreSQL (Neon in dev, RDS in production)
- **Queue:** Redis (BullMQ)
- **ORM:** Prisma
- **AI Integration:** Google Gemini API

## Architecture
```
src/
├── modules/           # Feature modules
│   ├── auth/         # Authentication
│   ├── jobs/         # Job queue management
│   ├── files/        # File upload/processing
│   ├── accessibility/ # PDF/EPUB validation
│   └── compliance/   # Content compliance checking
├── shared/           # Shared utilities
│   ├── middleware/   # Express middleware
│   ├── utils/        # Helper functions
│   └── types/        # TypeScript types
└── index.ts          # Application entry point
```

## CRITICAL RULES - DO NOT VIOLATE

### Database Safety
- ❌ NEVER run DROP TABLE or DROP DATABASE
- ❌ NEVER modify Prisma schema without explicit approval
- ❌ NEVER run destructive migrations automatically
- ✅ Use Prisma migrations for all schema changes
- ✅ Test migrations in isolated environment first

### Code Patterns
- ✅ Use async/await for all asynchronous operations
- ✅ Use Zod for input validation
- ✅ Follow existing module structure
- ✅ Add error handling to all API endpoints
- ❌ NEVER expose API keys in frontend code
- ❌ NEVER commit secrets to Git

### Testing
- ✅ Write tests for new functionality
- ✅ Run `npm test` before committing
- ✅ Ensure all tests pass before pushing

## Recovery Commands

If something breaks:

```bash
# Reset node_modules
rm -rf node_modules package-lock.json
npm install

# Reset Prisma client
npx prisma generate

# Check database connection
npx prisma db pull

# View logs
npm run dev 2>&1 | tail -100
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/auth/login | User authentication |
| POST | /api/v1/jobs | Create validation job |
| GET | /api/v1/jobs/:id | Get job status |
| POST | /api/v1/files/upload | Upload document |

## Environment Variables Required

- DATABASE_URL
- REDIS_URL
- GEMINI_API_KEY
- JWT_SECRET
- NODE_ENV
```

### Step 3.4: Create Backend replit.nix

Ensure `replit.nix` contains:

```nix
{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm
    pkgs.nodePackages.typescript
    pkgs.postgresql_15
    pkgs.poppler_utils
    pkgs.ghostscript
    pkgs.imagemagick
    pkgs.openjdk17
    pkgs.pandoc
    pkgs.git
    pkgs.curl
    pkgs.jq
  ];

  env = {
    JAVA_HOME = "${pkgs.openjdk17}";
    NODE_OPTIONS = "--max-old-space-size=4096";
  };
}
```

### Step 3.5: Create Backend .replit

Ensure `.replit` contains:

```toml
run = "npm run dev"
entrypoint = "src/index.ts"
modules = ["nodejs-20:v8-20230920-bd784b9"]
hidden = [".config", "package-lock.json", ".git"]

[nix]
channel = "stable-23_11"

[[ports]]
localPort = 3000
externalPort = 80

[env]
NODE_OPTIONS = "--max-old-space-size=4096"
```

---

## 4. Frontend Project Setup

### Step 4.1: Import Frontend Repository

1. Click **+ Create Repl**
2. Select **Import from GitHub**
3. Enter repository URL: `https://github.com/s4cindia/ninja-frontend`
4. Click **Import from GitHub**
5. Wait for the import to complete

### Step 4.2: Configure Neon Database History Retention

**Important:** Set history retention to minimize storage costs.

1. Go to the Neon Console (https://console.neon.tech)
2. Select your project
3. Navigate to **Settings** → **Storage**
4. Set **History retention** to **6 hours**
5. Click **Save**

**Why 6 hours?** This provides sufficient recovery window during active development while minimizing the Neon billing risk from AI Agent operations that create excessive write operations. Since AWS RDS is your production database, 6 hours is pragmatic for development.

### Step 4.3: Configure Environment Variables

Navigate to **Tools** → **Secrets** and add the following:

| Key | Description | Example Value |
|-----|-------------|---------------|
| `VITE_API_URL` | Backend API URL | `https://ninja-backend.replit.app` |
| `VITE_APP_NAME` | Application name | `Ninja Platform` |

### Step 4.4: Create Frontend replit.md

Create a file named `replit.md` in the project root with the following content:

```markdown
# Ninja Platform Frontend

## Project Overview
This is the Ninja Platform frontend - a React-based SaaS application for accessibility and compliance validation of educational publishing content.

## Tech Stack
- **Framework:** React 18 with TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS
- **UI Components:** Radix UI
- **State Management:** Zustand
- **Data Fetching:** TanStack Query (React Query)
- **Routing:** React Router v6
- **Forms:** React Hook Form + Zod

## Project Structure
```
src/
├── components/        # Reusable UI components
│   ├── ui/           # Base UI components (Button, Input, etc.)
│   ├── forms/        # Form components
│   ├── layout/       # Layout components (Header, Sidebar)
│   └── features/     # Feature-specific components
├── pages/            # Page components (routes)
│   ├── Dashboard/
│   ├── Jobs/
│   ├── Reports/
│   └── Settings/
├── hooks/            # Custom React hooks
├── stores/           # Zustand state stores
├── services/         # API service functions
├── utils/            # Utility functions
├── types/            # TypeScript type definitions
└── App.tsx           # Root application component
```

## CRITICAL RULES - DO NOT VIOLATE

### Security
- ❌ NEVER store API keys in frontend code
- ❌ NEVER expose sensitive data in console.log
- ❌ NEVER commit .env files to Git
- ✅ Use environment variables (VITE_*) for configuration
- ✅ All API calls go through backend proxy

### Code Patterns
- ✅ Use functional components with hooks
- ✅ Use TypeScript strict mode
- ✅ Follow existing component structure
- ✅ Use Tailwind CSS for styling (no inline styles)
- ✅ Use Radix UI for accessible components
- ❌ NEVER use `any` type
- ❌ NEVER disable ESLint rules without approval

### State Management
- ✅ Use TanStack Query for server state
- ✅ Use Zustand for client state
- ❌ NEVER store server data in Zustand
- ❌ NEVER mutate state directly

### Accessibility
- ✅ All interactive elements must be keyboard accessible
- ✅ Use semantic HTML elements
- ✅ Provide alt text for images
- ✅ Use ARIA labels where needed
- ✅ Test with screen reader

## Component Guidelines

### Creating New Components
```tsx
// src/components/ui/Button.tsx
import { forwardRef } from 'react';
import { cn } from '@/utils/cn';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'rounded-md font-medium transition-colors',
          // variant styles
          // size styles
          className
        )}
        {...props}
      />
    );
  }
);
```

### API Integration Pattern
```tsx
// src/services/jobs.ts
import { api } from './api';
import type { Job, CreateJobRequest } from '@/types';

export const jobsService = {
  create: (data: CreateJobRequest) => 
    api.post<Job>('/api/v1/jobs', data),

  getById: (id: string) => 
    api.get<Job>(`/api/v1/jobs/${id}`),

  list: (params?: { status?: string }) => 
    api.get<Job[]>('/api/v1/jobs', { params }),
};
```

### Using TanStack Query
```tsx
// src/hooks/useJobs.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { jobsService } from '@/services/jobs';

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => jobsService.list(),
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: jobsService.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
```

## Recovery Commands

If something breaks:

```bash
# Reset node_modules
rm -rf node_modules package-lock.json
npm install

# Clear Vite cache
rm -rf node_modules/.vite

# Rebuild
npm run build

# Check for TypeScript errors
npx tsc --noEmit

# Check for ESLint errors
npm run lint
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| VITE_API_URL | Backend API base URL |
| VITE_APP_NAME | Application display name |

## Design System

### Colors (Tailwind)
- Primary: `blue-600` / `blue-700`
- Success: `green-600`
- Warning: `amber-500`
- Error: `red-600`
- Background: `gray-50` / `white`
- Text: `gray-900` / `gray-600`

### Spacing
- Use Tailwind spacing scale (4, 8, 16, 24, 32, 48)
- Consistent padding: `p-4` for cards, `p-6` for sections

### Typography
- Headings: `font-semibold`
- Body: `font-normal`
- Small: `text-sm text-gray-600`
```

### Step 4.5: Create Frontend replit.nix

Ensure `replit.nix` contains:

```nix
{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm
    pkgs.nodePackages.typescript
    pkgs.git
  ];
}
```

### Step 4.6: Create Frontend .replit

Ensure `.replit` contains:

```toml
run = "npm run dev"
entrypoint = "src/App.tsx"
modules = ["nodejs-20:v8-20230920-bd784b9"]
hidden = [".config", "package-lock.json", ".git"]

[nix]
channel = "stable-23_11"

[[ports]]
localPort = 5173
externalPort = 80

[env]
NODE_OPTIONS = "--max-old-space-size=4096"
```

---

## 5. Claude Code Setup (Optional - For Debugging)

Claude Code is Anthropic's command-line tool for agentic coding. It's recommended for complex debugging sessions.

### Step 5.1: Install Claude Code

```bash
# Install globally
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version
```

### Step 5.2: Configure API Key

```bash
# Set API key (one-time setup)
export ANTHROPIC_API_KEY="your-api-key-here"

# Or add to your shell profile (~/.bashrc or ~/.zshrc)
echo 'export ANTHROPIC_API_KEY="your-api-key-here"' >> ~/.bashrc
```

### Step 5.3: Initialize in Project

```bash
# Navigate to project directory
cd ninja-backend  # or ninja-frontend

# Initialize Claude Code
claude init

# This creates a CLAUDE.md file for project context
```

### Step 5.4: Basic Usage

```bash
# Start Claude Code in interactive mode
claude

# Ask a question
> Why is the authentication failing?

# Claude will read your codebase and provide analysis
```

For detailed Claude Code debugging workflows, see the **Ninja Platform Developer Training Guide**.

---

## 6. Verification Steps

### Step 6.1: Verify Backend Setup

1. Click **Run** button in Replit
2. Wait for npm install to complete
3. Verify server starts without errors
4. Check console for: "Server running on port 3000"
5. Open the Webview tab to verify API responds

### Step 6.2: Verify Frontend Setup

1. Click **Run** button in Replit
2. Wait for npm install to complete
3. Verify Vite dev server starts
4. Check console for: "Local: http://localhost:5173"
5. Open the Webview tab to see the application

### Step 6.3: Verify Git Integration

```bash
# Check Git status
git status

# Verify remote
git remote -v
# Should show: origin https://github.com/s4cindia/ninja-backend.git (or frontend)

# Pull latest changes
git pull origin main
```

---

## 7. Troubleshooting

### Problem: npm install fails

**Solution:**
```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

### Problem: Database connection fails

**Solution:**
1. Verify DATABASE_URL in Secrets
2. Check Neon dashboard for connection status
3. Ensure `?sslmode=require` is in connection string
4. Wait 5 seconds for cold start

### Problem: Secrets not loading

**Solution:**
1. Stop the Repl
2. Verify secret names are exact (case-sensitive)
3. Restart the Repl
4. Check with: `console.log(process.env.YOUR_SECRET_NAME)`

### Problem: Port already in use

**Solution:**
1. Click **Stop** button
2. Wait 5 seconds
3. Click **Run** again
4. If persists, refresh the browser tab

---

## 8. Next Steps

After completing setup:

1. Read the **Replit Teams Guide v2** for collaboration workflows
2. Complete the **Ninja Platform Developer Training Guide**
3. Review the **Sprint Replit Prompts** for your assigned sprint
4. Join the #ninja-development Teams channel

---

*Version: 2.1 | Last Updated: December 2025*
