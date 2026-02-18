-- Add editorial service job types to JobType enum (idempotent)

-- Add CITATION_DETECTION
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'CITATION_DETECTION'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobType')
    ) THEN
        ALTER TYPE "JobType" ADD VALUE 'CITATION_DETECTION';
    END IF;
END
$$;

-- Add CITATION_VALIDATION
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'CITATION_VALIDATION'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobType')
    ) THEN
        ALTER TYPE "JobType" ADD VALUE 'CITATION_VALIDATION';
    END IF;
END
$$;

-- Add PLAGIARISM_CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'PLAGIARISM_CHECK'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobType')
    ) THEN
        ALTER TYPE "JobType" ADD VALUE 'PLAGIARISM_CHECK';
    END IF;
END
$$;

-- Add STYLE_VALIDATION
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'STYLE_VALIDATION'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobType')
    ) THEN
        ALTER TYPE "JobType" ADD VALUE 'STYLE_VALIDATION';
    END IF;
END
$$;

-- Add EDITORIAL_FULL
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'EDITORIAL_FULL'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobType')
    ) THEN
        ALTER TYPE "JobType" ADD VALUE 'EDITORIAL_FULL';
    END IF;
END
$$;
