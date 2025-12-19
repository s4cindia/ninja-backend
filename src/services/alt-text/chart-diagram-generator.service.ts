import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { logger } from '../../lib/logger';

type ImageType = 
  | 'BAR_CHART'
  | 'LINE_CHART'
  | 'PIE_CHART'
  | 'SCATTER_PLOT'
  | 'FLOWCHART'
  | 'ORG_CHART'
  | 'DIAGRAM'
  | 'TABLE_IMAGE'
  | 'MAP'
  | 'INFOGRAPHIC'
  | 'PHOTO'
  | 'UNKNOWN';

interface ChartDescription {
  imageId: string;
  imageType: ImageType;
  shortAlt: string;
  longDescription: string;
  dataTable?: DataTableRow[];
  trends?: string[];
  keyFindings?: string[];
  confidence: number;
  flags: string[];
  aiModel: string;
  generatedAt: Date;
}

interface DataTableRow {
  label: string;
  values: (string | number)[];
}

class ChartDiagramGeneratorService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  }

  async classifyImage(
    imageBuffer: Buffer,
    mimeType: string = 'image/jpeg'
  ): Promise<ImageType> {
    const prompt = `
Classify this image into ONE of these categories:
- BAR_CHART (vertical or horizontal bars showing quantities)
- LINE_CHART (lines connecting data points over time/sequence)
- PIE_CHART (circular chart divided into slices)
- SCATTER_PLOT (dots plotted on x-y axes)
- FLOWCHART (boxes connected by arrows showing process/decisions)
- ORG_CHART (hierarchical structure of organization/relationships)
- DIAGRAM (technical drawing, schematic, or explanatory illustration)
- TABLE_IMAGE (screenshot or image of a data table)
- MAP (geographical map or floor plan)
- INFOGRAPHIC (combination of graphics, charts, and text)
- PHOTO (photograph of real-world scene)
- UNKNOWN (cannot determine)

Return ONLY the category name, nothing else.
`;

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    try {
      const result = await this.model.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text().trim().toUpperCase();
      
      const validTypes: ImageType[] = [
        'BAR_CHART', 'LINE_CHART', 'PIE_CHART', 'SCATTER_PLOT',
        'FLOWCHART', 'ORG_CHART', 'DIAGRAM', 'TABLE_IMAGE',
        'MAP', 'INFOGRAPHIC', 'PHOTO', 'UNKNOWN'
      ];
      
      return validTypes.includes(text as ImageType) ? text as ImageType : 'UNKNOWN';
    } catch (error) {
      console.error('Image classification failed:', error);
      return 'UNKNOWN';
    }
  }

  async generateChartDescription(
    imageBuffer: Buffer,
    mimeType: string = 'image/jpeg'
  ): Promise<ChartDescription> {
    const imageType = await this.classifyImage(imageBuffer, mimeType);
    const prompt = this.getPromptForType(imageType);

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    try {
      const result = await this.model.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
      } catch (parseError) {
        logger.error('Failed to parse chart description JSON:', { text: text.substring(0, 500), error: parseError });
        return {
          imageId: '',
          imageType,
          shortAlt: `${this.formatImageType(imageType)} requiring manual description`,
          longDescription: 'Unable to parse AI response. Manual review required.',
          confidence: 0,
          flags: ['LOW_CONFIDENCE', 'PARSE_ERROR'],
          aiModel: 'gemini-1.5-pro',
          generatedAt: new Date(),
        };
      }

      return {
        imageId: '',
        imageType,
        shortAlt: this.truncate(parsed.shortAlt || '', 125),
        longDescription: parsed.longDescription || '',
        dataTable: parsed.dataTable,
        trends: parsed.trends,
        keyFindings: parsed.keyFindings,
        confidence: parsed.confidence || 70,
        flags: this.determineFlags(imageType, parsed),
        aiModel: 'gemini-1.5-pro',
        generatedAt: new Date(),
      };
    } catch (error) {
      logger.error('Chart description generation failed:', error);
      return {
        imageId: '',
        imageType,
        shortAlt: `${this.formatImageType(imageType)} requiring manual description`,
        longDescription: 'Unable to generate automatic description. Manual review required.',
        confidence: 0,
        flags: ['LOW_CONFIDENCE', 'GENERATION_FAILED'],
        aiModel: 'gemini-1.5-pro',
        generatedAt: new Date(),
      };
    }
  }

  private getPromptForType(imageType: ImageType): string {
    const baseInstructions = `
Requirements:
- shortAlt: Under 125 characters, summarize what the visualization shows
- longDescription: Detailed description up to 500 words
- Do NOT start with "Image of", "Chart showing", etc.
- Use present tense
- Be specific about data values when visible

Return JSON only (no markdown):
`;

    switch (imageType) {
      case 'BAR_CHART':
      case 'LINE_CHART':
      case 'PIE_CHART':
      case 'SCATTER_PLOT':
        return `
Analyze this data visualization chart.

${baseInstructions}
{
  "shortAlt": "brief summary of what data the chart presents",
  "longDescription": "detailed description including title, axes labels, data series, specific values, and trends",
  "dataTable": [
    { "label": "Category/X-axis value", "values": [value1, value2] }
  ],
  "trends": ["trend 1", "trend 2"],
  "keyFindings": ["finding 1", "finding 2"],
  "confidence": 85
}

For the dataTable, extract visible data points. Include axis labels and units.
For trends, describe patterns like "increasing", "peak in Q3", "correlation between X and Y".
For keyFindings, note the main takeaways a reader should understand.
`;

      case 'FLOWCHART':
      case 'ORG_CHART':
        return `
Analyze this flowchart or organizational diagram.

${baseInstructions}
{
  "shortAlt": "brief summary of the process or structure shown",
  "longDescription": "step-by-step description of the flow, including decision points, branches, and outcomes OR hierarchical description of organizational structure",
  "keyFindings": ["key point 1", "key point 2"],
  "confidence": 85
}

Describe the flow from start to end, noting:
- Starting point
- Each step or position
- Decision points and their branches
- End points or outcomes
- Relationships between elements
`;

      case 'DIAGRAM':
      case 'INFOGRAPHIC':
        return `
Analyze this diagram or infographic.

${baseInstructions}
{
  "shortAlt": "brief summary of what the diagram explains",
  "longDescription": "comprehensive description of all visual elements, labels, relationships, and information conveyed",
  "keyFindings": ["key point 1", "key point 2"],
  "confidence": 85
}

Describe:
- Main subject or topic
- All labeled components
- Relationships between parts
- Any data or statistics shown
- Color coding or visual conventions used
`;

      case 'TABLE_IMAGE':
        return `
Analyze this table image.

${baseInstructions}
{
  "shortAlt": "brief description of what data the table contains",
  "longDescription": "description of table structure, headers, and summary of content",
  "dataTable": [
    { "label": "Row header", "values": ["col1 value", "col2 value"] }
  ],
  "keyFindings": ["key point 1"],
  "confidence": 85
}

Extract the table data into the dataTable array. Include column headers as the first row.
`;

      case 'MAP':
        return `
Analyze this map.

${baseInstructions}
{
  "shortAlt": "brief description of what area/data the map shows",
  "longDescription": "description of geographic area, any data overlays, legends, and key features",
  "keyFindings": ["key point 1"],
  "confidence": 85
}

Describe:
- Geographic area covered
- Type of map (political, topographic, data visualization, floor plan)
- Any data layers or color coding
- Legend explanation
- Notable features or locations marked
`;

      default:
        return `
Describe this image for someone who cannot see it.

${baseInstructions}
{
  "shortAlt": "concise description under 125 chars",
  "longDescription": "detailed description of the image content",
  "confidence": 75
}
`;
    }
  }

  private determineFlags(imageType: ImageType, parsed: { dataTable?: DataTableRow[]; confidence?: number }): string[] {
    const flags: string[] = [];

    if (imageType !== 'PHOTO' && imageType !== 'UNKNOWN') {
      flags.push('DATA_VISUALIZATION');
    }

    if (parsed.dataTable && parsed.dataTable.length > 0) {
      flags.push('DATA_EXTRACTED');
    }

    if (parsed.confidence !== undefined && parsed.confidence < 70) {
      flags.push('LOW_CONFIDENCE');
    }

    if (imageType === 'INFOGRAPHIC' || imageType === 'DIAGRAM') {
      flags.push('COMPLEX_IMAGE');
    }

    return flags;
  }

  private formatImageType(type: ImageType): string {
    return type.replace(/_/g, ' ').toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  needsLongDescription(result: ChartDescription): boolean {
    const complexTypes: ImageType[] = [
      'BAR_CHART', 'LINE_CHART', 'PIE_CHART', 'SCATTER_PLOT',
      'FLOWCHART', 'ORG_CHART', 'DIAGRAM', 'TABLE_IMAGE',
      'INFOGRAPHIC'
    ];
    return complexTypes.includes(result.imageType);
  }
}

export const chartDiagramGenerator = new ChartDiagramGeneratorService();
export type { ChartDescription, ImageType, DataTableRow };
