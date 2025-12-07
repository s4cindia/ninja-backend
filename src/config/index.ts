import dotenv from 'dotenv';
dotenv.config();

import packageJson from '../../package.json';

interface Config {
  port: number;
  nodeEnv: string;
  version: string;
}

const config: Config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  version: packageJson.version
};

export default config;
