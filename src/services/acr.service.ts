import fs from 'fs';
import path from 'path';

interface Criterion {
  id: string;
  number: string;
  name: string;
  level: 'A' | 'AA' | 'AAA' | 'EU';
  section: string;
  description: string;
  wcagUrl?: string | null;
}

interface Edition {
  code: string;
  name: string;
  description: string;
  totalCount: number;
  standard: string;
  criteriaIds: string[];
}

interface AcrEditionsData {
  editions: Edition[];
  criteria: Criterion[];
}

export class AcrService {
  private editionsData: AcrEditionsData;

  constructor() {
    const dataPath = path.join(__dirname, '../data/acrEditions.json');
    const rawData = fs.readFileSync(dataPath, 'utf-8');
    this.editionsData = JSON.parse(rawData);
  }

  getAllEditions() {
    return this.editionsData.editions.map(edition => ({
      code: edition.code,
      name: edition.name,
      description: edition.description,
      totalCount: edition.totalCount,
      standard: edition.standard,
    }));
  }

  getEditionCriteria(editionCode: string) {
    const edition = this.editionsData.editions.find(e => e.code === editionCode);

    if (!edition) {
      throw new Error(`Edition '${editionCode}' not found`);
    }

    const criteria = edition.criteriaIds
      .map(id => this.editionsData.criteria.find(c => c.id === id))
      .filter(c => c !== undefined) as Criterion[];

    const groupedCriteria = {
      A: criteria.filter(c => c.level === 'A'),
      AA: criteria.filter(c => c.level === 'AA'),
      AAA: criteria.filter(c => c.level === 'AAA'),
      EU: criteria.filter(c => c.level === 'EU'),
    };

    return {
      edition: {
        code: edition.code,
        name: edition.name,
        description: edition.description,
        totalCount: edition.totalCount,
        standard: edition.standard,
      },
      criteriaByLevel: groupedCriteria,
      criteriaCount: {
        A: groupedCriteria.A.length,
        AA: groupedCriteria.AA.length,
        AAA: groupedCriteria.AAA.length,
        EU: groupedCriteria.EU.length,
        total: criteria.length,
      },
    };
  }

  getCriterionById(criterionId: string) {
    const criterion = this.editionsData.criteria.find(c => c.id === criterionId);

    if (!criterion) {
      throw new Error(`Criterion '${criterionId}' not found`);
    }

    return criterion;
  }
}

export const acrService = new AcrService();
