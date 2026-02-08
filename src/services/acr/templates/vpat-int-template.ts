export const VPAT_INT_TEMPLATE = {
  edition: 'VPAT2.5-INT',
  title: 'Voluntary Product Accessibility Template (VPAT) - International Edition',
  standards: ['Section 508', 'EN 301 549', 'WCAG 2.1'],
  description: 'The International Edition combines all requirements from US Section 508, European EN 301 549, and WCAG 2.1. This is the recommended edition for multinational vendors as it satisfies requirements across jurisdictions in a single document.',
  sections: [
    {
      id: 'wcag-a',
      title: 'Table 1: Success Criteria, Level A',
      description: 'WCAG 2.1 Level A criteria'
    },
    {
      id: 'wcag-aa',
      title: 'Table 2: Success Criteria, Level AA',
      description: 'WCAG 2.1 Level AA criteria'
    },
    {
      id: 'wcag-aaa',
      title: 'Table 3: Success Criteria, Level AAA (Optional)',
      description: 'WCAG 2.1 Level AAA criteria (optional reporting)'
    },
    {
      id: 'revised-508',
      title: 'Revised Section 508 Report',
      description: 'US Federal accessibility requirements',
      subsections: [
        {
          id: 'chapter-3',
          title: 'Chapter 3: Functional Performance Criteria (FPC)',
          description: 'Section 508 functional performance criteria'
        },
        {
          id: 'chapter-4',
          title: 'Chapter 4: Hardware',
          description: 'Section 508 hardware requirements'
        },
        {
          id: 'chapter-5',
          title: 'Chapter 5: Software',
          description: 'Section 508 software requirements'
        },
        {
          id: 'chapter-6',
          title: 'Chapter 6: Support Documentation and Services',
          description: 'Section 508 documentation requirements'
        }
      ]
    },
    {
      id: 'en-301-549',
      title: 'EN 301 549 Report',
      description: 'European accessibility requirements for EAA compliance',
      subsections: [
        {
          id: 'en-chapter-4',
          title: 'Chapter 4: Functional Performance Statements',
          description: 'EN 301 549 functional performance statements'
        },
        {
          id: 'en-chapter-5',
          title: 'Chapter 5: Generic Requirements',
          description: 'EN 301 549 generic requirements'
        },
        {
          id: 'en-chapter-6',
          title: 'Chapter 6: ICT with Two-Way Voice Communication',
          description: 'Voice communication requirements'
        },
        {
          id: 'en-chapter-7',
          title: 'Chapter 7: ICT with Video Capabilities',
          description: 'Video capability requirements'
        },
        {
          id: 'en-chapter-8',
          title: 'Chapter 8: Hardware',
          description: 'Hardware requirements'
        },
        {
          id: 'en-chapter-9',
          title: 'Chapter 9: Web',
          description: 'Web accessibility (maps to WCAG 2.1)'
        },
        {
          id: 'en-chapter-10',
          title: 'Chapter 10: Non-web Documents',
          description: 'Document accessibility requirements'
        },
        {
          id: 'en-chapter-11',
          title: 'Chapter 11: Software',
          description: 'Software requirements'
        },
        {
          id: 'en-chapter-12',
          title: 'Chapter 12: Documentation and Support Services',
          description: 'Documentation requirements'
        },
        {
          id: 'en-chapter-13',
          title: 'Chapter 13: ICT Providing Relay or Emergency Service Access',
          description: 'Emergency and relay services'
        }
      ]
    }
  ],
  benefits: [
    'Single document satisfies US, EU, and international requirements',
    'Reduces maintenance overhead for multinational vendors',
    'Demonstrates comprehensive accessibility commitment',
    'Simplifies procurement for global organizations',
    'Gold standard for government and institutional sales'
  ]
};
