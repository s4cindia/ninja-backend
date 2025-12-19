import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

interface LongDescription {
  id: string;
  imageId: string;
  jobId: string;
  content: {
    html: string;
    plainText: string;
    markdown: string;
  };
  wordCount: number;
  sections?: DescriptionSection[];
  generatedAt: Date;
  aiModel: string;
}

interface DescriptionSection {
  heading: string;
  content: string;
}

type LongDescriptionTrigger = 
  | 'COMPLEX_CHART'
  | 'MANY_COMPONENTS'
  | 'DENSE_INFORMATION'
  | 'DATA_TABLE'
  | 'FLOWCHART'
  | 'MANUAL_REQUEST';

class LongDescriptionGeneratorService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  }

  needsLongDescription(
    imageType: string,
    flags: string[],
    shortAltLength: number
  ): { needed: boolean; triggers: LongDescriptionTrigger[] } {
    const triggers: LongDescriptionTrigger[] = [];

    const complexTypes = ['BAR_CHART', 'LINE_CHART', 'PIE_CHART', 'SCATTER_PLOT', 'TABLE_IMAGE'];
    if (complexTypes.includes(imageType)) {
      triggers.push('COMPLEX_CHART');
    }

    if (imageType === 'FLOWCHART' || imageType === 'ORG_CHART') {
      triggers.push('FLOWCHART');
    }

    if (flags.includes('COMPLEX_IMAGE') || flags.includes('DATA_VISUALIZATION')) {
      triggers.push('DENSE_INFORMATION');
    }

    if (flags.includes('DATA_EXTRACTED')) {
      triggers.push('DATA_TABLE');
    }

    if (shortAltLength >= 120) {
      triggers.push('MANY_COMPONENTS');
    }

    return {
      needed: triggers.length > 0,
      triggers,
    };
  }

  async generateLongDescription(
    imageBuffer: Buffer,
    mimeType: string,
    trigger: LongDescriptionTrigger,
    existingShortAlt?: string
  ): Promise<LongDescription> {
    const prompt = `
Generate a comprehensive long description for this image to be used with aria-describedby for accessibility.

${existingShortAlt ? `Short alt text: "${existingShortAlt}"` : ''}

Trigger: ${trigger}

Requirements:
- Write a detailed prose description (300-500 words)
- Structure with clear sections if the image has distinct parts
- For charts/graphs: describe all data points, trends, and axes
- For flowcharts: describe each step and decision in sequence
- For diagrams: explain all components and their relationships
- For tables: describe all rows and columns of data
- Use clear, plain language
- Do NOT use "Image shows" or similar phrases
- Present tense

Return JSON only (no markdown):
{
  "plainText": "Full prose description...",
  "markdown": "# Title\\n\\nDescription with **emphasis** and structure...",
  "html": "<h2>Title</h2><p>Description...</p>",
  "sections": [
    { "heading": "Overview", "content": "..." },
    { "heading": "Data Details", "content": "..." }
  ],
  "wordCount": 350
}
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
      const text = response.text();
      const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));

      return {
        id: '',
        imageId: '',
        jobId: '',
        content: {
          html: parsed.html || this.textToHtml(parsed.plainText),
          plainText: parsed.plainText,
          markdown: parsed.markdown || parsed.plainText,
        },
        wordCount: parsed.wordCount || this.countWords(parsed.plainText),
        sections: parsed.sections,
        generatedAt: new Date(),
        aiModel: 'gemini-1.5-pro',
      };
    } catch (error) {
      console.error('Long description generation failed:', error);
      throw error;
    }
  }

  private textToHtml(text: string): string {
    const paragraphs = text.split('\n\n').filter(p => p.trim());
    return paragraphs.map(p => `<p>${p.trim()}</p>`).join('\n');
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter(w => w.length > 0).length;
  }

  generateAriaMarkup(
    imageId: string,
    shortAlt: string,
    longDescription: LongDescription
  ): {
    imgTag: string;
    descriptionDiv: string;
  } {
    const descId = `desc-${imageId}`;
    const escapedAlt = shortAlt.replace(/"/g, '&quot;');
    
    return {
      imgTag: `<img src="..." alt="${escapedAlt}" aria-describedby="${descId}" />`,
      descriptionDiv: `<div id="${descId}" class="sr-only">\n${longDescription.content.html}\n</div>`,
    };
  }
}

export const longDescriptionGenerator = new LongDescriptionGeneratorService();
export type { LongDescription, LongDescriptionTrigger, DescriptionSection };
