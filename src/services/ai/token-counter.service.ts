import { getModelPricing } from '../../config/pricing.config';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: 'USD';
}

export interface UsageRecord {
  id: string;
  tenantId: string;
  userId: string;
  model: string;
  operation: string;
  usage: TokenUsage;
  cost: CostEstimate;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

class TokenCounterService {
  private usageRecords: UsageRecord[] = [];

  estimateTokens(text: string): number {
    if (!text) return 0;
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const avgTokensPerWord = 1.3;
    return Math.ceil(words.length * avgTokensPerWord);
  }

  calculateCost(usage: TokenUsage, model: string): CostEstimate {
    const pricing = getModelPricing(model);
    
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.completionTokens / 1_000_000) * pricing.output;
    
    return {
      inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,
      outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
      totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
      currency: 'USD',
    };
  }

  recordUsage(
    tenantId: string,
    userId: string,
    model: string,
    operation: string,
    usage: TokenUsage,
    metadata?: Record<string, unknown>
  ): UsageRecord {
    const cost = this.calculateCost(usage, model);
    
    const record: UsageRecord = {
      id: `usage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      tenantId,
      userId,
      model,
      operation,
      usage,
      cost,
      timestamp: new Date(),
      metadata,
    };
    
    this.usageRecords.push(record);
    
    console.log(`[AI Usage] Tenant: ${tenantId}, Op: ${operation}, Tokens: ${usage.totalTokens}, Cost: $${cost.totalCost.toFixed(6)}`);
    
    return record;
  }

  getTenantUsageSummary(
    tenantId: string,
    startDate?: Date,
    endDate?: Date
  ): {
    totalTokens: number;
    totalCost: number;
    requestCount: number;
    byModel: Record<string, { tokens: number; cost: number; requests: number }>;
    byOperation: Record<string, { tokens: number; cost: number; requests: number }>;
  } {
    let records = this.usageRecords.filter(r => r.tenantId === tenantId);
    
    if (startDate) {
      records = records.filter(r => r.timestamp >= startDate);
    }
    if (endDate) {
      records = records.filter(r => r.timestamp <= endDate);
    }
    
    const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};
    const byOperation: Record<string, { tokens: number; cost: number; requests: number }> = {};
    
    let totalTokens = 0;
    let totalCost = 0;
    
    for (const record of records) {
      totalTokens += record.usage.totalTokens;
      totalCost += record.cost.totalCost;
      
      if (!byModel[record.model]) {
        byModel[record.model] = { tokens: 0, cost: 0, requests: 0 };
      }
      byModel[record.model].tokens += record.usage.totalTokens;
      byModel[record.model].cost += record.cost.totalCost;
      byModel[record.model].requests += 1;
      
      if (!byOperation[record.operation]) {
        byOperation[record.operation] = { tokens: 0, cost: 0, requests: 0 };
      }
      byOperation[record.operation].tokens += record.usage.totalTokens;
      byOperation[record.operation].cost += record.cost.totalCost;
      byOperation[record.operation].requests += 1;
    }
    
    return {
      totalTokens,
      totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
      requestCount: records.length,
      byModel,
      byOperation,
    };
  }

  getRecentUsage(tenantId: string, limit = 100): UsageRecord[] {
    return this.usageRecords
      .filter(r => r.tenantId === tenantId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  estimateCost(promptText: string, model: string, expectedOutputTokens = 1000): CostEstimate {
    const promptTokens = this.estimateTokens(promptText);
    return this.calculateCost(
      { promptTokens, completionTokens: expectedOutputTokens, totalTokens: promptTokens + expectedOutputTokens },
      model
    );
  }

  clearOldRecords(olderThan: Date): number {
    const initialCount = this.usageRecords.length;
    this.usageRecords = this.usageRecords.filter(r => r.timestamp >= olderThan);
    return initialCount - this.usageRecords.length;
  }
}

export const tokenCounterService = new TokenCounterService();
