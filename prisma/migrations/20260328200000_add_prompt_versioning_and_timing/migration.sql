-- Add prompt versioning and run config to AiAnnotationRun
ALTER TABLE "AiAnnotationRun" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;
ALTER TABLE "AiAnnotationRun" ADD COLUMN IF NOT EXISTS "confidenceThreshold" DOUBLE PRECISION;
ALTER TABLE "AiAnnotationRun" ADD COLUMN IF NOT EXISTS "dryRun" BOOLEAN NOT NULL DEFAULT false;

-- Add annotation mode to AnnotationSession
ALTER TABLE "AnnotationSession" ADD COLUMN IF NOT EXISTS "annotationMode" TEXT;
