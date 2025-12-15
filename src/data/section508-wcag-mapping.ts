export interface Section508WcagMapping {
  section508Id: string;
  section508Title: string;
  category: 'E205' | 'E206' | 'Chapter3' | 'Chapter6';
  wcagCriteria: string[];
  description: string;
  pdfUaRelevant: boolean;
}

export const section508WcagMappings: Section508WcagMapping[] = [
  {
    section508Id: 'E205.2',
    section508Title: 'WCAG Conformance',
    category: 'E205',
    wcagCriteria: ['1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.2.5', '1.3.1', '1.3.2', '1.3.3', '1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5'],
    description: 'Electronic content shall conform to Level A and Level AA Success Criteria in WCAG 2.0',
    pdfUaRelevant: true,
  },
  {
    section508Id: 'E205.4',
    section508Title: 'PDF/UA Accessibility',
    category: 'E205',
    wcagCriteria: ['1.1.1', '1.3.1', '1.3.2', '2.4.1', '2.4.2', '2.4.5', '3.1.1'],
    description: 'Documents in PDF format shall conform to PDF/UA-1 (ISO 14289-1)',
    pdfUaRelevant: true,
  },
  {
    section508Id: '501.1',
    section508Title: 'Scope - Accessibility Requirements',
    category: 'E205',
    wcagCriteria: ['1.1.1', '1.3.1', '1.4.1', '2.1.1', '2.4.1', '3.1.1', '4.1.1', '4.1.2'],
    description: 'ICT that is procured, developed, maintained, or used shall conform to applicable accessibility requirements',
    pdfUaRelevant: true,
  },
  {
    section508Id: '502.3.1',
    section508Title: 'Object Information',
    category: 'E205',
    wcagCriteria: ['1.1.1', '4.1.2'],
    description: 'The object role, states, properties, boundary, name, and description shall be programmatically determinable',
    pdfUaRelevant: true,
  },
  {
    section508Id: '502.3.3',
    section508Title: 'Row, Column, and Headers',
    category: 'E205',
    wcagCriteria: ['1.3.1'],
    description: 'Where a data table is displayed, header relationships shall be programmatically determinable',
    pdfUaRelevant: true,
  },
  {
    section508Id: '504.2',
    section508Title: 'Content Creation and Editing',
    category: 'E206',
    wcagCriteria: ['1.1.1', '1.3.1', '1.4.3', '2.4.6'],
    description: 'Authoring tools shall provide a mode of operation to create accessible electronic content',
    pdfUaRelevant: false,
  },
  {
    section508Id: '302.1',
    section508Title: 'Without Vision',
    category: 'Chapter3',
    wcagCriteria: ['1.1.1', '1.3.1', '1.3.3', '2.1.1', '4.1.2'],
    description: 'Where visual mode of operation is provided, ICT shall provide at least one mode that does not require user vision',
    pdfUaRelevant: true,
  },
  {
    section508Id: '302.2',
    section508Title: 'With Limited Vision',
    category: 'Chapter3',
    wcagCriteria: ['1.4.3', '1.4.4', '1.4.6', '1.4.10', '1.4.11', '1.4.12'],
    description: 'ICT shall provide at least one mode that provides enhanced visual information',
    pdfUaRelevant: true,
  },
  {
    section508Id: '302.3',
    section508Title: 'Without Perception of Color',
    category: 'Chapter3',
    wcagCriteria: ['1.4.1', '1.4.3', '1.4.11'],
    description: 'Where color is used to convey information, ICT shall provide a visual mode that does not require perception of color',
    pdfUaRelevant: true,
  },
  {
    section508Id: '302.4',
    section508Title: 'Without Hearing',
    category: 'Chapter3',
    wcagCriteria: ['1.2.1', '1.2.2', '1.4.2'],
    description: 'Where an audible mode of operation is provided, ICT shall provide at least one mode that does not require user hearing',
    pdfUaRelevant: false,
  },
  {
    section508Id: '302.5',
    section508Title: 'With Limited Hearing',
    category: 'Chapter3',
    wcagCriteria: ['1.2.4', '1.4.2'],
    description: 'Where an audible mode of operation is provided, ICT shall provide at least one mode that enhances audio clarity',
    pdfUaRelevant: false,
  },
  {
    section508Id: '302.6',
    section508Title: 'Without Speech',
    category: 'Chapter3',
    wcagCriteria: ['2.1.1', '2.1.2'],
    description: 'Where speech is required, ICT shall provide at least one mode that does not require user speech',
    pdfUaRelevant: false,
  },
  {
    section508Id: '302.7',
    section508Title: 'With Limited Manipulation',
    category: 'Chapter3',
    wcagCriteria: ['2.1.1', '2.1.2', '2.4.1', '2.4.7', '2.5.1'],
    description: 'Where manual operation is provided, ICT shall provide at least one mode that does not require fine motor control',
    pdfUaRelevant: true,
  },
  {
    section508Id: '302.8',
    section508Title: 'With Limited Reach and Strength',
    category: 'Chapter3',
    wcagCriteria: ['2.1.1', '2.5.4'],
    description: 'Where operation requires reach or strength, ICT shall provide at least one mode that accommodates limited reach or strength',
    pdfUaRelevant: false,
  },
  {
    section508Id: '302.9',
    section508Title: 'With Limited Language, Cognitive, and Learning Abilities',
    category: 'Chapter3',
    wcagCriteria: ['1.3.1', '2.4.2', '2.4.4', '2.4.6', '3.1.1', '3.1.2', '3.2.3', '3.2.4', '3.3.1', '3.3.2'],
    description: 'ICT shall provide features making its use by individuals with limited cognitive abilities simpler and easier',
    pdfUaRelevant: true,
  },
  {
    section508Id: '602.2',
    section508Title: 'Accessibility and Compatibility Features',
    category: 'Chapter6',
    wcagCriteria: [],
    description: 'Documentation shall list and explain how to use accessibility features',
    pdfUaRelevant: false,
  },
  {
    section508Id: '602.3',
    section508Title: 'Documentation in Alternate Formats',
    category: 'Chapter6',
    wcagCriteria: ['1.1.1', '1.3.1'],
    description: 'Documentation shall be provided in electronic format that conforms to E205',
    pdfUaRelevant: true,
  },
  {
    section508Id: '602.4',
    section508Title: 'Technical Support',
    category: 'Chapter6',
    wcagCriteria: [],
    description: 'ICT support services shall accommodate communication needs of individuals with disabilities',
    pdfUaRelevant: false,
  },
];

export const wcagToSection508Map: Map<string, string[]> = new Map();

section508WcagMappings.forEach(mapping => {
  mapping.wcagCriteria.forEach(wcag => {
    const existing = wcagToSection508Map.get(wcag) || [];
    if (!existing.includes(mapping.section508Id)) {
      existing.push(mapping.section508Id);
      wcagToSection508Map.set(wcag, existing);
    }
  });
});

export function getSection508MappingsForWcag(wcagCriterion: string): Section508WcagMapping[] {
  return section508WcagMappings.filter(m => m.wcagCriteria.includes(wcagCriterion));
}

export function getWcagCriteriaForSection508(section508Id: string): string[] {
  const mapping = section508WcagMappings.find(m => m.section508Id === section508Id);
  return mapping?.wcagCriteria || [];
}

export function getPdfUaRelevantMappings(): Section508WcagMapping[] {
  return section508WcagMappings.filter(m => m.pdfUaRelevant);
}
