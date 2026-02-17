import dotenv from 'dotenv';
dotenv.config();

export interface Config {
  port: number;
  nodeEnv: string;
  version: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  maxFileSize: number;
  uploadDir: string;
  aceServiceUrl: string | null;
  javaPath: string | null;
  s3Bucket: string;
  s3Region: string;
  awsAccessKeyId: string | null;
  awsSecretAccessKey: string | null;
}

export const config: Config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  version: process.env.npm_package_version || '1.0.0',
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-in-production',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'development-refresh-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins: (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN)?.split(',') || ['http://localhost:5173', 'http://localhost:3000'],
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10),
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  aceServiceUrl: process.env.ACE_SERVICE_URL || null,
  javaPath: process.env.JAVA_PATH || null,
  s3Bucket: process.env.S3_BUCKET || 'ninja-epub-staging',
  s3Region: process.env.S3_REGION || 'ap-south-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || null,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
};

export default config;
