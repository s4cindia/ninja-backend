export interface RemediationConfig {
  colorContrastAutoFix: boolean;
}

const defaultConfig: RemediationConfig = {
  colorContrastAutoFix: true,
};

let currentConfig: RemediationConfig = { ...defaultConfig };

export function getRemediationConfig(): RemediationConfig {
  return { ...currentConfig };
}

export function updateRemediationConfig(updates: Partial<RemediationConfig>): RemediationConfig {
  currentConfig = { ...currentConfig, ...updates };
  return { ...currentConfig };
}

export function resetRemediationConfig(): RemediationConfig {
  currentConfig = { ...defaultConfig };
  return { ...currentConfig };
}

export function isColorContrastAutoFixEnabled(): boolean {
  return currentConfig.colorContrastAutoFix;
}
