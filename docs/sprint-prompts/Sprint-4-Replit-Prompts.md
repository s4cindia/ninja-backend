# Sprint 4 Replit Prompts
## Metadata + ONIX + Citation + EPUB ACR Integration

**Version:** 4.0 — Merged Scope  
**Sprint Duration:** January 10 - January 24, 2026  
**Total Story Points:** 110

---

## Sprint 4 Technical Standards

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **API Framework** | Express 4.x |
| **Module System** | ES Modules (import/export) |
| **Validation** | Zod schemas |
| **ORM** | Prisma |
| **Async Pattern** | async/await (no callbacks) |
| **File Naming** | kebab-case for files, PascalCase for classes/interfaces |
| **Base Path** | All code in `src/` |
| **Testing** | Jest with TypeScript |
| **PDF Libraries** | pdf-lib, pdfjs-dist |
| **EPUB Libraries** | epub-parser, jszip |
| **XML Libraries** | fast-xml-parser, xmlbuilder2 |
| **AI Integration** | Google Gemini API (@google/generative-ai) |

---

## Epic 4.1: Metadata Extraction

### US-4.1.1: PDF Metadata Extraction (5 pts)

#### Context
We're building the Ninja Platform metadata extraction module. This enables publishers to automatically populate catalog records from uploaded documents, reducing manual data entry.

#### Prerequisites
- Sprint 2 PDF parsing services complete
- Sprint 3 accessibility audit complete
- PDF structure analysis working

#### Current State
You should have:
- `src/services/pdf/pdf-parser.service.ts` - Basic PDF parsing
- `src/services/pdf/structure-analyzer.service.ts` - Structure tree extraction
- Job processing infrastructure with S3 storage

#### Objective
Create a comprehensive PDF metadata extraction service that pulls XMP, Document Info, and content-derived metadata.

#### Technical Requirements

```
Create a PDF metadata extraction service.

**Create file: `src/services/metadata/pdf-metadata-extractor.service.ts`**

interface ExtractedPdfMetadata {
  // XMP Metadata (Dublin Core)
  xmp: {
    title?: string;
    creator?: string[];      // dc:creator (authors)
    subject?: string[];      // dc:subject (keywords)
    description?: string;    // dc:description
    publisher?: string;
    date?: string;           // Publication date
    rights?: string;
    language?: string;
  };

  // Document Info Dictionary
  documentInfo: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;        // Creating application
    producer?: string;       // PDF producer
    creationDate?: Date;
    modificationDate?: Date;
  };

  // Content-Derived
  contentDerived: {
    isbn?: string;           // Extracted from text
    isbnType?: 'ISBN-10' | 'ISBN-13';
    doi?: string;
    detectedLanguage?: string;
    pageCount: number;
    wordCount?: number;
  };

  // Technical
  technical: {
    pdfVersion: string;
    pageSize: { width: number; height: number; unit: 'pt' };
    isTagged: boolean;
    hasXmp: boolean;
    fileSize: number;
  };
}

**Implementation details:**

1. **XMP Extraction**
   - Parse XMP packet from PDF metadata stream
   - Handle both RDF/XML and simple XMP formats
   - Extract all Dublin Core (dc:) namespace elements
   - Extract XMP Basic (xmp:) namespace for dates

2. **Document Info Extraction**
   - Read PDF trailer /Info dictionary
   - Parse date strings (D:YYYYMMDDHHmmSS format)
   - Handle encoding issues (PDFDocEncoding, UTF-16BE)

3. **ISBN Extraction from Content**
   - Regex patterns for ISBN-10 and ISBN-13:
     ISBN-13: /(?:ISBN[-:]?\s*)?(?:978|979)[-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?\d/gi
     ISBN-10: /(?:ISBN[-:]?\s*)?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?[\dX]/gi
   - Validate checksum before accepting
   - Search copyright page (first 10 pages) first

4. **Language Detection**
   - Use text sample from first 5 pages
   - Call language detection library (e.g., franc)
   - Return ISO 639-1 code

**Create file: `src/utils/isbn-validator.ts`**

function validateIsbn10(isbn: string): boolean {
  // Remove hyphens, validate checksum
  // Check digit = (11 - sum) mod 11, where X = 10
}

function validateIsbn13(isbn: string): boolean {
  // Remove hyphens, validate checksum
  // Check digit = (10 - sum) mod 10
}

function convertIsbn10To13(isbn10: string): string {
  // Prepend 978, recalculate check digit
}

function formatIsbn(isbn: string): string {
  // Add hyphens per ISBN ranges
}

**Create API endpoint:**
POST /api/v1/metadata/extract/pdf
Body: { jobId: string }
Response: ExtractedPdfMetadata

**Implementation Notes:**
- Use pdf-lib for metadata access
- Cache extracted metadata in database
- Handle missing fields gracefully (don't error on missing XMP)
- Log extraction duration for performance monitoring
```

#### Acceptance Criteria
- [ ] Extract XMP metadata: dc:title, dc:creator, dc:subject, dc:description, dc:publisher, dc:date
- [ ] Extract Document Info: Title, Author, Subject, Keywords, Creator, Producer, dates
- [ ] Extract ISBN from text using regex with checksum validation
- [ ] Detect language from content analysis
- [ ] Extract technical metadata: page count, dimensions, PDF version

---

### US-4.1.2: EPUB Metadata Extraction (5 pts)

#### Context
EPUB files contain rich metadata in the OPF package document. This service extracts all available metadata for catalog population.

#### Prerequisites
- US-4.1.1 complete
- EPUB upload and storage working

#### Current State
You should have:
- File upload handling for EPUB files
- EPUB stored in S3

#### Objective
Create an EPUB metadata extraction service that parses OPF package metadata.

#### Technical Requirements

```
Create an EPUB metadata extraction service.

**Create file: `src/services/metadata/epub-metadata-extractor.service.ts`**

interface ExtractedEpubMetadata {
  // Package info
  package: {
    version: '2.0' | '3.0' | '3.2';
    uniqueIdentifier: string;
    direction?: 'ltr' | 'rtl';
  };

  // Dublin Core elements
  dublinCore: {
    identifier: IdentifierElement[];  // ISBN, DOI, UUID
    title: TitleElement[];
    creator: ContributorElement[];
    contributor: ContributorElement[];
    language: string[];
    publisher?: string;
    date?: string;
    description?: string;
    subject: string[];
    rights?: string;
    source?: string;
    coverage?: string;
    type?: string;
    format?: string;
    relation?: string;
  };

  // EPUB 3 meta properties
  meta: {
    modifiedDate?: string;     // dcterms:modified
    accessMode?: string[];
    accessModeSufficient?: string[];
    accessibilityFeature?: string[];
    accessibilityHazard?: string[];
    accessibilitySummary?: string;
    conformsTo?: string[];     // Accessibility spec
  };

  // Spine and manifest info
  structure: {
    itemCount: number;
    hasNcx: boolean;
    hasNav: boolean;
    hasCover: boolean;
    coverImagePath?: string;
    mediaTypes: string[];
  };
}

interface IdentifierElement {
  value: string;
  scheme?: string;  // 'ISBN', 'DOI', 'UUID'
}

interface TitleElement {
  value: string;
  titleType?: string;  // 'main', 'subtitle', 'collection'
  sequence?: number;
}

interface ContributorElement {
  name: string;
  fileAs?: string;       // Sort name
  role?: string;         // MARC relator code
  roleDisplay?: string;  // Human-readable role
}

**Implementation:**

1. **Unzip EPUB**
   - Use JSZip to extract contents
   - Find META-INF/container.xml
   - Locate OPF file path from rootfile

2. **Parse OPF (EPUB 2)**
   - Parse XML using fast-xml-parser
   - Extract <dc:*> elements from <metadata>
   - Handle opf:role attributes for creators
   - Parse <spine> for reading order

3. **Parse OPF (EPUB 3)**
   - Same as EPUB 2 plus:
   - Extract <meta property="..."> elements
   - Handle refines="#id" for linked metadata
   - Parse accessibility properties

4. **Extract identifiers**
   - Parse dc:identifier with opf:scheme attribute
   - Detect ISBN, DOI, UUID from value patterns
   - Validate ISBN checksums

5. **Locate cover**
   - Check manifest for item with properties="cover-image"
   - Check <meta name="cover" content="..."/> (EPUB 2)
   - Extract dimensions if image accessible

**Create API endpoint:**
POST /api/v1/metadata/extract/epub
Body: { jobId: string }
Response: ExtractedEpubMetadata
```

#### Acceptance Criteria
- [ ] Parse OPF package (EPUB 2 and EPUB 3)
- [ ] Extract Dublin Core elements with role attributes
- [ ] Extract EPUB 3 meta properties (dcterms:modified, accessibility features)
- [ ] Extract identifiers: ISBN, DOI, UUID
- [ ] Extract cover image reference and dimensions

---

### US-4.1.3: Metadata Normalization (8 pts)

#### Context
Metadata from different sources (PDF XMP, PDF Info, EPUB OPF) uses different formats. This service normalizes everything to a consistent model.

#### Prerequisites
- US-4.1.1 and US-4.1.2 complete

#### Objective
Create a normalization service that maps various source formats to a unified metadata model.

#### Technical Requirements

```
Create a metadata normalization service.

**Create file: `src/services/metadata/metadata-normalizer.service.ts`**

interface NormalizedMetadata {
  // Core identification
  identifiers: {
    isbn13?: string;         // Always ISBN-13 with hyphens
    isbn10?: string;         // Original if provided
    doi?: string;
    oclc?: string;
    lccn?: string;
    uuid?: string;
  };

  // Titles
  titles: {
    main: string;
    subtitle?: string;
    seriesTitle?: string;
    seriesNumber?: number;
  };

  // Contributors
  contributors: NormalizedContributor[];

  // Subject classification
  subjects: {
    keywords: string[];
    bisacCodes?: string[];
    bicCodes?: string[];
    themaCodes?: string[];
  };

  // Description
  descriptions: {
    short?: string;          // 150 chars
    medium?: string;         // 500 chars
    long?: string;           // 2000+ chars
    toc?: string;            // Table of contents text
  };

  // Publication info
  publication: {
    publisher?: string;
    publisherLocation?: string;
    publicationDate?: string;  // ISO 8601
    copyrightYear?: number;
    edition?: string;
    language: string;          // ISO 639-2/B
    countryOfPublication?: string;
  };

  // Technical
  format: {
    type: 'PDF' | 'EPUB' | 'DOCX';
    pageCount?: number;
    wordCount?: number;
    fileSize: number;
    dimensions?: { width: number; height: number; unit: string };
  };

  // Accessibility (from EPUB or audit)
  accessibility?: {
    conformsTo?: string[];
    accessMode?: string[];
    accessibilityFeature?: string[];
    accessibilityHazard?: string[];
    accessibilitySummary?: string;
  };

  // Provenance
  extractionInfo: {
    sourceFormat: string;
    extractedAt: Date;
    extractionVersion: string;
    fieldsFromSource: string[];    // Which fields came from original
    fieldsGenerated: string[];     // Which fields were derived/AI-generated
    confidence: Record<string, number>;  // Confidence per field
  };
}

interface NormalizedContributor {
  name: string;              // Display name
  nameInverted: string;      // "Last, First" for sorting
  role: ContributorRole;
  roleCode?: string;         // MARC relator
  sequence: number;          // Order of appearance
  isOrganization: boolean;
}

type ContributorRole = 
  | 'author'
  | 'editor'
  | 'translator'
  | 'illustrator'
  | 'photographer'
  | 'contributor'
  | 'foreword_author'
  | 'introduction_author';

**Normalization rules:**

1. **Contributor names**
   - Parse "First Last" → "Last, First"
   - Handle suffixes (Jr., III, PhD)
   - Handle organizations (no inversion)
   - Use existing file-as if provided

2. **Dates**
   - Convert all dates to ISO 8601 (YYYY-MM-DD)
   - Handle partial dates (YYYY, YYYY-MM)
   - Parse various formats: "January 1, 2024", "01/01/2024", "2024"

3. **ISBN normalization**
   - Remove hyphens for validation
   - Convert ISBN-10 to ISBN-13
   - Add hyphens per ISBN ranges
   - Store both formats if ISBN-10 provided

4. **Language codes**
   - Map ISO 639-1 (en) to ISO 639-2/B (eng)
   - Handle common variations (English → eng)
   - Default to 'eng' if detection fails

5. **Merge multiple sources**
   - Prefer EPUB OPF over PDF XMP for ebooks
   - Prefer PDF XMP over Document Info
   - Merge contributor lists with deduplication
   - Keep highest-confidence value for conflicts

**Create API endpoint:**
POST /api/v1/metadata/normalize
Body: { jobId: string, sources?: string[] }
Response: NormalizedMetadata
```

#### Acceptance Criteria
- [ ] Map source fields to unified metadata model
- [ ] Normalize contributor names (Last, First format)
- [ ] Standardize dates to ISO 8601
- [ ] Validate and format ISBN (hyphenation, 10↔13 conversion)
- [ ] Map language codes to ISO 639-2/B

---

## Epic 4.2: AI Enrichment

### US-4.2.1: BISAC Category Suggestions (8 pts)

#### Context
BISAC (Book Industry Standards and Communications) codes are critical for book discoverability in retail. AI can suggest appropriate categories based on content analysis.

#### Prerequisites
- US-4.1.3 complete
- Gemini API integration available
- Text extraction from documents working

#### Current State
You should have:
- `src/services/ai/gemini-client.ts` - Gemini API wrapper
- Normalized metadata available

#### Objective
Create an AI-powered BISAC category suggestion service.

#### Technical Requirements

```
Create a BISAC suggestion service using Gemini AI.

**Create file: `src/services/metadata/bisac-suggester.service.ts`**

interface BisacSuggestion {
  code: string;           // e.g., "FIC027020"
  heading: string;        // e.g., "FICTION / Romance / Contemporary"
  confidence: number;     // 0-100
  reasoning: string;      // Why this category
  isPrimary: boolean;
}

interface BisacSuggestionResult {
  primary: BisacSuggestion;
  secondary: BisacSuggestion[];  // Up to 5
  inputUsed: {
    title: boolean;
    description: boolean;
    sampleContent: boolean;
    existingSubjects: boolean;
  };
}

**Load BISAC codes: `src/data/bisac-2024.ts`**

// Load full BISAC 2024 subject headings (~4,000 codes)
// Structure: { code: string, heading: string, parent?: string }

**Implementation:**

1. **Prepare input for AI**
   - Use title and subtitle
   - Use description (if available)
   - Extract sample content (first 2000 chars of body text)
   - Include any existing subject keywords

2. **Gemini prompt:**

const BISAC_PROMPT = `
You are a professional book cataloger. Analyze this book and suggest BISAC subject codes.

Title: {title}
Subtitle: {subtitle}
Description: {description}
Sample content: {sampleContent}
Existing keywords: {keywords}

Suggest the most appropriate BISAC codes from the 2024 BISAC Subject Headings list.

Return JSON:
{
  "primary": {
    "code": "FIC027020",
    "heading": "FICTION / Romance / Contemporary",
    "confidence": 95,
    "reasoning": "The romance elements and modern setting clearly place this in contemporary romance"
  },
  "secondary": [
    { "code": "...", "heading": "...", "confidence": 80, "reasoning": "..." }
  ]
}

Rules:
- Primary code should have highest confidence (>70%)
- Include up to 5 secondary codes
- Each code must be a valid 2024 BISAC code
- Reasoning should be specific to content
`;

3. **Validate suggestions**
   - Verify each code exists in BISAC 2024 list
   - Reject codes with confidence < 50%
   - Ensure primary has highest confidence

4. **User override tracking**
   - Store AI suggestions separately from user selections
   - Track when user changes AI suggestion
   - Use feedback for future improvement

**Create API endpoints:**

POST /api/v1/metadata/suggest/bisac
Body: { jobId: string }
Response: BisacSuggestionResult

PUT /api/v1/metadata/:jobId/bisac
Body: { primaryCode: string, secondaryCodes: string[], source: 'ai' | 'user' }
Response: { success: boolean }

GET /api/v1/reference/bisac/search?q=romance
Response: { results: BisacCode[] }
```

#### Acceptance Criteria
- [ ] Analyze title, description, and sample content
- [ ] Suggest primary BISAC code with confidence score
- [ ] Suggest up to 5 secondary BISAC codes ranked by relevance
- [ ] Support BISAC 2024 subject headings (~4,000 codes)
- [ ] Allow user selection and override with tracking

---

### US-4.2.2: Keyword Extraction (5 pts)

#### Context
Keywords improve search discoverability. Extract relevant terms from document content.

#### Prerequisites
- US-4.1.3 complete
- Text extraction working

#### Technical Requirements

```
Create a keyword extraction service.

**Create file: `src/services/metadata/keyword-extractor.service.ts`**

interface ExtractedKeywords {
  keywords: KeywordItem[];
  namedEntities: NamedEntity[];
  topicSummary: string;
}

interface KeywordItem {
  term: string;
  type: 'single' | 'phrase';
  score: number;           // Relevance 0-100
  frequency: number;       // Occurrence count
  source: 'tfidf' | 'ai' | 'metadata';
}

interface NamedEntity {
  text: string;
  type: 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'DATE' | 'WORK';
  frequency: number;
}

**Implementation:**

1. **TF-IDF extraction**
   - Tokenize document text
   - Remove stopwords
   - Calculate term frequency
   - Calculate inverse document frequency (use corpus stats)
   - Extract top 20 single terms

2. **Phrase extraction**
   - Use n-gram analysis (2-3 words)
   - Filter for noun phrases
   - Score by frequency and coherence

3. **AI refinement**

const KEYWORD_PROMPT = `
Analyze this text and extract the most important keywords for search optimization.

Text sample: {textSample}
TF-IDF keywords: {tfidfKeywords}

Return JSON:
{
  "keywords": [
    { "term": "machine learning", "type": "phrase", "score": 95 },
    { "term": "neural networks", "type": "phrase", "score": 88 }
  ],
  "namedEntities": [
    { "text": "Stanford University", "type": "ORGANIZATION" },
    { "text": "California", "type": "LOCATION" }
  ],
  "topicSummary": "This text discusses artificial intelligence applications in healthcare."
}

Rules:
- Include 10-20 keywords
- Mix single words and phrases
- Prioritize terms that would help readers find this content
- Identify all significant named entities
`;

4. **Merge and deduplicate**
   - Combine TF-IDF and AI keywords
   - Remove duplicates and near-duplicates
   - Re-rank combined list

**Create API endpoint:**
POST /api/v1/metadata/extract/keywords
Body: { jobId: string, maxKeywords?: number }
Response: ExtractedKeywords
```

#### Acceptance Criteria
- [ ] Extract 10-20 keywords from document content
- [ ] Include single words and key phrases (2-3 words)
- [ ] Rank by relevance using TF-IDF + AI refinement
- [ ] Detect named entities (people, places, organizations)

---

### US-4.2.3: AI Description Generation (8 pts)

#### Context
Generate marketing descriptions in multiple lengths for different use cases.

#### Prerequisites
- US-4.1.3 complete
- US-4.2.1 and US-4.2.2 complete

#### Technical Requirements

```
Create an AI description generator service.

**Create file: `src/services/metadata/description-generator.service.ts`**

interface GeneratedDescriptions {
  short: string;           // 150 chars for social media
  medium: string;          // 500 chars for catalogs
  long: string;            // 2000 chars for websites
  tone: DescriptionTone;
  aiGenerated: boolean;
  editHistory: DescriptionEdit[];
}

type DescriptionTone = 
  | 'academic'      // Scholarly, formal
  | 'literary'      // Artistic, literary
  | 'commercial'    // Sales-focused
  | 'educational'   // Instructional
  | 'children';     // Age-appropriate

interface DescriptionEdit {
  timestamp: Date;
  editor: string;
  version: 'short' | 'medium' | 'long';
  previousText: string;
}

**Implementation:**

const DESCRIPTION_PROMPT = `
You are a professional book marketer. Generate compelling descriptions for this book.

Title: {title}
Author: {author}
Genre/Category: {bisacHeading}
Keywords: {keywords}
Sample content: {sampleContent}
Existing description (if any): {existingDescription}

Generate three versions:

1. SHORT (exactly 150 characters max): A punchy hook for social media
2. MEDIUM (exactly 500 characters max): A catalog description with key selling points
3. LONG (exactly 2000 characters max): A full marketing description for website

Tone: {tone}

Rules for {tone} tone:
- academic: Use formal language, mention methodology, target scholarly audience
- literary: Use evocative language, focus on themes and style
- commercial: Use action words, emphasize benefits, include call-to-action
- educational: Focus on learning outcomes, target educators
- children: Age-appropriate language, mention age range, parent appeal

Additional rules:
- For fiction: DO NOT include spoilers
- Include: target audience, key themes, unique selling points
- For non-fiction: mention author credentials if available
- End with subtle call-to-action

Return JSON:
{
  "short": "...",
  "medium": "...",
  "long": "...",
  "tone": "commercial"
}
`;

**Detect appropriate tone:**

function detectTone(bisacCode: string, metadata: NormalizedMetadata): DescriptionTone {
  if (bisacCode.startsWith('JUV') || bisacCode.startsWith('JNF')) return 'children';
  if (bisacCode.startsWith('EDU')) return 'educational';
  if (bisacCode.startsWith('LIT') || bisacCode.startsWith('POE')) return 'literary';
  if (bisacCode.startsWith('SCI') || bisacCode.startsWith('MED') || bisacCode.startsWith('PHI')) return 'academic';
  return 'commercial';
}

**Create API endpoints:**

POST /api/v1/metadata/generate/descriptions
Body: { jobId: string, tone?: DescriptionTone }
Response: GeneratedDescriptions

PUT /api/v1/metadata/:jobId/descriptions
Body: { short?: string, medium?: string, long?: string }
Response: { success: boolean }
```

#### Acceptance Criteria
- [ ] Generate short description (150 chars for social media)
- [ ] Generate medium description (500 chars for catalog)
- [ ] Generate long description (2000 chars for website)
- [ ] Match tone to genre (academic, literary, commercial)
- [ ] Avoid spoilers for fiction; include selling points and audience

---

## Epic 4.3: ONIX Generation

### US-4.3.1: ONIX 3.0 Message Generation (8 pts)

#### Context
ONIX (ONline Information eXchange) is the international standard for book metadata. Publishers must provide ONIX feeds to retailers like Amazon, Ingram, and libraries.

#### Prerequisites
- US-4.1.3 (Metadata Normalization) complete
- US-4.2.1-4.2.3 (AI Enrichment) complete

#### Current State
You should have:
- `NormalizedMetadata` model populated
- BISAC codes and descriptions generated

#### Objective
Generate valid ONIX 3.0 XML messages from normalized metadata.

#### Technical Requirements

```
Create an ONIX 3.0 generator service.

**Create file: `src/services/onix/onix-generator.service.ts`**

interface OnixGenerationOptions {
  format: 'reference' | 'short';  // Tag style
  includeAccessibility: boolean;
  includeSupplyDetail: boolean;
  messageNote?: string;
}

interface OnixMessage {
  xml: string;
  productCount: number;
  validationResult: OnixValidationResult;
}

**ONIX 3.0 Structure:**

<ONIXMessage release="3.0">
  <Header>
    <Sender>
      <SenderName>{publisherName}</SenderName>
      <ContactName>{contactName}</ContactName>
      <EmailAddress>{email}</EmailAddress>
    </Sender>
    <SentDateTime>{isoDate}</SentDateTime>
    <MessageNote>{note}</MessageNote>
  </Header>
  <Product>
    <RecordReference>{uuid}</RecordReference>
    <NotificationType>03</NotificationType>  <!-- New -->

    <ProductIdentifier>
      <ProductIDType>15</ProductIDType>  <!-- ISBN-13 -->
      <IDValue>{isbn13}</IDValue>
    </ProductIdentifier>

    <DescriptiveDetail>
      <ProductComposition>00</ProductComposition>
      <ProductForm>ED</ProductForm>  <!-- EPUB -->
      <ProductFormDetail>E101</ProductFormDetail>

      <TitleDetail>
        <TitleType>01</TitleType>  <!-- Distinctive title -->
        <TitleElement>
          <TitleElementLevel>01</TitleElementLevel>
          <TitleText>{title}</TitleText>
          <Subtitle>{subtitle}</Subtitle>
        </TitleElement>
      </TitleDetail>

      <Contributor>
        <SequenceNumber>1</SequenceNumber>
        <ContributorRole>A01</ContributorRole>  <!-- Author -->
        <PersonName>{name}</PersonName>
        <PersonNameInverted>{lastFirst}</PersonNameInverted>
      </Contributor>

      <Language>
        <LanguageRole>01</LanguageRole>
        <LanguageCode>{languageCode}</LanguageCode>
      </Language>

      <Subject>
        <MainSubject/>
        <SubjectSchemeIdentifier>10</SubjectSchemeIdentifier>  <!-- BISAC -->
        <SubjectCode>{bisacCode}</SubjectCode>
        <SubjectHeadingText>{bisacHeading}</SubjectHeadingText>
      </Subject>
    </DescriptiveDetail>

    <CollateralDetail>
      <TextContent>
        <TextType>03</TextType>  <!-- Description -->
        <ContentAudience>00</ContentAudience>
        <Text>{description}</Text>
      </TextContent>
    </CollateralDetail>

    <PublishingDetail>
      <Publisher>
        <PublishingRole>01</PublishingRole>
        <PublisherName>{publisher}</PublisherName>
      </Publisher>
      <PublishingDate>
        <PublishingDateRole>01</PublishingDateRole>
        <Date>{publicationDate}</Date>
      </PublishingDate>
    </PublishingDetail>
  </Product>
</ONIXMessage>

**Implementation:**

1. Use xmlbuilder2 for XML generation
2. Support both reference names and short tags
3. Map all normalized metadata to ONIX elements
4. Include ONIX codelists (use current versions)

**Create ONIX codelist mappings: `src/data/onix-codelists.ts`**

// List 5: Product identifier type
// List 15: Title type
// List 17: Contributor role
// List 74: Language code
// List 150: Product form
// List 196: Accessibility features

**Create API endpoint:**
POST /api/v1/onix/generate
Body: { jobId: string, options: OnixGenerationOptions }
Response: OnixMessage
```

#### Acceptance Criteria
- [ ] Generate valid ONIX 3.0 XML (reference names and short tags)
- [ ] Include all core blocks: ProductIdentifier, DescriptiveDetail, CollateralDetail, PublishingDetail
- [ ] Map BISAC codes to ONIX Subject with scheme identifier
- [ ] Include accessibility metadata (ONIX List 196)
- [ ] Validate against ONIX 3.0.8 XSD schema

---

### US-4.3.2: Retailer-Specific Templates (5 pts)

#### Context
Different retailers have specific requirements for ONIX feeds. Templates customize output for each channel.

#### Prerequisites
- US-4.3.1 complete

#### Technical Requirements

```
Create retailer-specific ONIX templates.

**Create file: `src/services/onix/templates/`**

**amazon-template.ts:**
interface AmazonOnixOptions {
  keywords: string[];         // Max 7 keywords
  browseNodes?: string[];     // Amazon browse categories
  aPlusContent?: boolean;     // Flag for A+ content eligibility
}

// Amazon-specific requirements:
// - Max 7 keywords in Subject
// - Specific product form codes
// - ASIN mapping if available

**ingram-template.ts:**
interface IngramOnixOptions {
  returnableIndicator: boolean;
  distributionStatus: string;
  poAvailability: string;
}

// Ingram requirements:
// - Supply detail required
// - Returns policy
// - Availability codes

**baker-taylor-template.ts:**
interface BakerTaylorOptions {
  marcRecordInclude: boolean;
  libraryBinding: boolean;
}

// Baker & Taylor (library):
// - MARC-friendly metadata
// - Library-specific subjects (LCSH)
// - Binding information

**google-books-template.ts:**
// Google Books requirements

**apple-books-template.ts:**
// Apple Books requirements

**Create template registry: `src/services/onix/template-registry.ts`**

type RetailerTemplate = 
  | 'amazon'
  | 'ingram'
  | 'baker-taylor'
  | 'google-books'
  | 'apple-books'
  | 'custom';

function getTemplate(retailer: RetailerTemplate): OnixTemplate {
  // Return appropriate template
}

**Create API endpoints:**

GET /api/v1/onix/templates
Response: { templates: RetailerTemplate[] }

POST /api/v1/onix/generate/:retailer
Body: { jobId: string, retailerOptions?: object }
Response: OnixMessage
```

#### Acceptance Criteria
- [ ] Amazon template with keywords (max 7), A+ content hooks
- [ ] Ingram template for wholesale distribution
- [ ] Baker & Taylor library template with MARC mapping
- [ ] Google Books and Apple Books templates
- [ ] Custom template builder for other retailers

---

### US-4.3.3: ONIX Validation (5 pts)

#### Context
ONIX messages must be validated before distribution to avoid retailer rejection.

#### Prerequisites
- US-4.3.1 complete

#### Technical Requirements

```
Create an ONIX validation service.

**Create file: `src/services/onix/onix-validator.service.ts`**

interface OnixValidationResult {
  isValid: boolean;
  schemaValid: boolean;
  codelistValid: boolean;
  businessRulesValid: boolean;
  errors: OnixValidationError[];
  warnings: OnixValidationWarning[];
}

interface OnixValidationError {
  type: 'schema' | 'codelist' | 'business';
  path: string;           // XPath to element
  code: string;           // Error code
  message: string;
  suggestion?: string;
}

**Validation layers:**

1. **Schema validation**
   - Validate against ONIX 3.0.8 XSD
   - Use libxmljs2 or xml-js for validation
   - Return detailed XPath errors

2. **Codelist validation**
   - Load current ONIX codelists
   - Verify all code values exist
   - Check deprecated codes

3. **Business rules**
   - ISBN checksum validation
   - Required fields per notification type
   - Date format validation
   - Price consistency checks

4. **Retailer-specific rules**
   - Check requirements per selected template
   - Warn on missing recommended fields

**Create API endpoint:**
POST /api/v1/onix/validate
Body: { xml: string } or { jobId: string }
Response: OnixValidationResult
```

#### Acceptance Criteria
- [ ] Validate XML against ONIX 3.0 XSD schema
- [ ] Check codelist values against current ONIX codelists
- [ ] Validate ISBN checksums
- [ ] Check required fields per retailer template
- [ ] Return detailed errors with fix suggestions

---

### US-4.3.4: ONIX 2.1 Export (8 pts)

#### Context
Some retailers and systems still require ONIX 2.1 format. Provide backward compatibility.

#### Prerequisites
- US-4.3.1 complete

#### Technical Requirements

```
Create ONIX 2.1 downgrade service.

**Create file: `src/services/onix/onix21-converter.service.ts`**

interface Onix21ConversionResult {
  xml: string;
  lossWarnings: DataLossWarning[];
  validationResult: OnixValidationResult;
}

interface DataLossWarning {
  field: string;
  onix3Value: string;
  reason: string;
}

**Conversion mappings:**

// ONIX 3.0 → 2.1 differences:
// - Different root element structure
// - Different codelist numbers
// - Some ONIX 3 features don't exist in 2.1

const CODELIST_MAPPINGS = {
  // List 5 (Product ID type) - mostly same
  // List 150 (Product form) - map new codes to nearest 2.1 equivalent
  // List 196 (Accessibility) - no equivalent in 2.1
};

function convertTo21(onix3Doc: OnixDocument): Onix21ConversionResult {
  // Transform structure
  // Map codelists
  // Log data loss
  // Validate against 2.1 DTD
}

**ONIX 2.1 structure differences:**
- Uses Product instead of ONIXMessage/Product
- Uses reference tags (ProductIdentifier) not short tags
- Different date formats
- No accessibility metadata support

**Create API endpoint:**
POST /api/v1/onix/convert/2.1
Body: { jobId: string } or { xml: string }
Response: Onix21ConversionResult
```

#### Acceptance Criteria
- [ ] Automatically downgrade ONIX 3.0 to 2.1 format
- [ ] Map ONIX 3.0 codelists to 2.1 equivalents
- [ ] Validate against ONIX 2.1 DTD
- [ ] Log fields that cannot be mapped (data loss warnings)

---

### US-4.3.5: CSV/Spreadsheet Export (3 pts)

#### Context
Not all systems support ONIX. Provide flat file exports for manual import or analysis.

#### Prerequisites
- US-4.1.3 complete

#### Technical Requirements

```
Create flat file export service.

**Create file: `src/services/export/spreadsheet-exporter.service.ts`**

type ExportTemplate = 
  | 'amazon'       // Amazon Seller Central format
  | 'library'      // Library-friendly with MARC fields
  | 'sales'        // Sales sheet (title, author, price, ISBN)
  | 'full';        // All available fields

interface ExportOptions {
  format: 'csv' | 'xlsx';
  template: ExportTemplate;
  encoding?: 'utf-8' | 'utf-8-bom' | 'latin1';
  jobIds?: string[];         // Specific jobs, or all if empty
  maxProducts?: number;      // Limit for batch
}

**CSV generation:**
- Use Papa Parse for CSV
- Use xlsx library for Excel
- UTF-8 BOM for Excel compatibility
- Handle special characters and line breaks in descriptions

**Template columns:**

AMAZON_COLUMNS = [
  'product-id', 'product-id-type', 'title', 'author', 
  'binding', 'publication-date', 'list-price', 'currency',
  'quantity', 'condition', 'description', 'keywords'
];

LIBRARY_COLUMNS = [
  'ISBN', 'Title', 'Author', 'Publisher', 'Publication Date',
  'BISAC Primary', 'BISAC Secondary', 'LC Classification',
  'Dewey', 'Description', 'Audience', 'Format'
];

FULL_COLUMNS = [
  // All normalized metadata fields
];

**Create API endpoints:**

POST /api/v1/export/spreadsheet
Body: ExportOptions
Response: { downloadUrl: string, rowCount: number }

GET /api/v1/export/templates
Response: { templates: ExportTemplate[] }
```

#### Acceptance Criteria
- [ ] Export CSV with UTF-8 BOM for Excel compatibility
- [ ] Export Excel (.xlsx) with formatted headers
- [ ] Preset templates: Amazon, Library, Sales Sheet, Full Export
- [ ] Support batch export (up to 10,000 products)

---

## Epic 4.4: Citation Validation

### US-4.4.1: Reference Extraction (8 pts)

#### Context
Academic and educational publishers need citation validation. Extract and parse references from documents.

#### Prerequisites
- PDF text extraction complete
- EPUB content access working

#### Technical Requirements

```
Create a reference extraction service.

**Create file: `src/services/citations/reference-extractor.service.ts`**

interface ExtractedReferences {
  references: ParsedReference[];
  detectedFormat: CitationFormat;
  confidence: number;
  inTextCitations: InTextCitation[];
}

interface ParsedReference {
  id: string;
  originalText: string;
  parsed: {
    authors?: Author[];
    title?: string;
    containerTitle?: string;  // Journal, book title
    publisher?: string;
    year?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    doi?: string;
    url?: string;
    accessDate?: string;
    edition?: string;
  };
  parseConfidence: number;
  type: ReferenceType;
}

type ReferenceType = 
  | 'journal-article'
  | 'book'
  | 'chapter'
  | 'conference-paper'
  | 'thesis'
  | 'website'
  | 'report'
  | 'unknown';

type CitationFormat = 
  | 'APA'
  | 'MLA'
  | 'Chicago-Author-Date'
  | 'Chicago-Notes'
  | 'Vancouver'
  | 'IEEE'
  | 'Harvard'
  | 'unknown';

interface InTextCitation {
  text: string;             // "(Smith, 2023)" or "[1]"
  location: { page: number; position: number };
  matchedReferenceId?: string;
}

**Implementation:**

1. **Detect reference section**
   - Search for headings: "References", "Bibliography", "Works Cited", "Literature Cited"
   - Handle variations and languages
   - Extract section content

2. **Split individual references**
   - Detect numbering patterns ([1], 1., •)
   - Handle hanging indents
   - Preserve original text

3. **Detect citation format**
   - APA: Author (Year). Title. *Journal*, volume(issue), pages. DOI
   - MLA: Author. "Title." *Container*, vol., no., year, pp.
   - Chicago: Author. Year. "Title." *Journal* volume (issue): pages.
   - Vancouver: Author. Title. Journal. Year;volume(issue):pages.
   - IEEE: [n] Author, "Title," *Journal*, vol., no., pp., year.

4. **Parse components**
   - Use regex patterns per format
   - Extract DOIs: /10\.\d{4,}\/[^\s]+/
   - Extract URLs
   - Parse author names

5. **Map in-text citations**
   - Find citation markers in body text
   - Match to reference list entries
   - Report unmatched citations

**Create API endpoint:**
POST /api/v1/citations/extract
Body: { jobId: string }
Response: ExtractedReferences
```

#### Acceptance Criteria
- [ ] Detect reference sections (Bibliography, References, Works Cited)
- [ ] Extract individual references preserving original text
- [ ] Parse components: author, title, journal/publisher, year, volume, pages, DOI
- [ ] Detect citation format (APA, MLA, Chicago, Vancouver, IEEE)
- [ ] Map in-text citations to references

---

### US-4.4.2: Citation Format Validation (5 pts)

#### Context
Validate citations against style guide rules for formatting correctness.

#### Prerequisites
- US-4.4.1 complete

#### Technical Requirements

```
Create a citation format validator.

**Create file: `src/services/citations/citation-validator.service.ts`**

interface CitationValidationResult {
  reference: ParsedReference;
  format: CitationFormat;
  isValid: boolean;
  errors: CitationError[];
  correctedText?: string;
}

interface CitationError {
  field: string;
  issue: string;
  rule: string;            // Style guide rule reference
  currentValue: string;
  expectedFormat: string;
  severity: 'error' | 'warning';
}

**Validation rules per format:**

APA 7th Edition:
- Author format: Last, F. M., & Last, F. M.
- Title: Sentence case, not italicized (articles), italicized (books)
- Journal: Italicized, Title Case
- DOI format: https://doi.org/10.xxxx/xxxxx
- Year in parentheses after author
- Volume italicized, issue in parentheses not italicized

MLA 9th Edition:
- Author format: Last, First, and First Last.
- Title in quotation marks (articles) or italics (books)
- Container in italics
- Core elements order: Author. Title. Container, Other contributors, Version, Number, Publisher, Date, Location.

Chicago 17th:
- Author-Date: Similar to APA
- Notes-Bibliography: Different format with notes

**Implementation:**

function validateReference(
  reference: ParsedReference,
  format: CitationFormat
): CitationValidationResult {
  const rules = getValidationRules(format);
  const errors: CitationError[] = [];

  // Check each component against rules
  for (const rule of rules) {
    const result = rule.validate(reference);
    if (!result.valid) {
      errors.push(result.error);
    }
  }

  // Generate corrected version
  const corrected = formatReference(reference, format);

  return { reference, format, isValid: errors.length === 0, errors, correctedText: corrected };
}

**Create API endpoint:**
POST /api/v1/citations/validate
Body: { jobId: string, format?: CitationFormat }
Response: { results: CitationValidationResult[] }
```

#### Acceptance Criteria
- [ ] Validate against APA 7th, MLA 9th, Chicago 17th edition rules
- [ ] Check punctuation, capitalization, italics usage
- [ ] Verify author name order and formatting
- [ ] Flag missing required elements
- [ ] Suggest corrections with correctly formatted version

---

### US-4.4.3: DOI Verification (7 pts)

#### Context
DOIs provide persistent links to publications. Verify they resolve correctly and match citation data.

#### Prerequisites
- US-4.4.1 complete

#### Technical Requirements

```
Create a DOI verification service.

**Create file: `src/services/citations/doi-verifier.service.ts`**

interface DoiVerificationResult {
  reference: ParsedReference;
  doi: string;
  exists: boolean;
  matchScore: number;        // 0-100 match with citation
  crossRefMetadata?: CrossRefMetadata;
  discrepancies: DoiDiscrepancy[];
  suggestedDoi?: string;     // If missing, suggest from CrossRef
}

interface CrossRefMetadata {
  title: string;
  authors: { given: string; family: string }[];
  containerTitle: string;
  publishedPrint?: string;
  publishedOnline?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  type: string;
}

interface DoiDiscrepancy {
  field: string;
  citationValue: string;
  doiValue: string;
}

**CrossRef API integration:**

async function verifyDoi(doi: string): Promise<CrossRefMetadata | null> {
  // GET https://api.crossref.org/works/{doi}
  // Parse response
  // Handle rate limiting (polite pool)
}

async function searchForDoi(reference: ParsedReference): Promise<string[]> {
  // POST https://api.crossref.org/works
  // Query by title and author
  // Return candidate DOIs
}

**Implementation:**

1. **Extract DOIs**
   - Pattern: /10\.\d{4,}\/[^\s]+/
   - Handle various formats: doi:, https://doi.org/, dx.doi.org
   - Normalize to standard format

2. **Verify DOI exists**
   - Call CrossRef API
   - Handle 404 (invalid DOI)
   - Cache results

3. **Compare metadata**
   - Compare title (fuzzy match)
   - Compare authors (name matching)
   - Compare year, volume, pages
   - Calculate match score

4. **Suggest missing DOIs**
   - For references without DOI
   - Search CrossRef by title/author
   - Return top candidates with confidence

5. **Support DataCite**
   - For dataset DOIs
   - Different API endpoint

**Create API endpoints:**

POST /api/v1/citations/verify/doi
Body: { jobId: string }
Response: { results: DoiVerificationResult[] }

POST /api/v1/citations/suggest/doi
Body: { reference: ParsedReference }
Response: { suggestions: { doi: string; confidence: number }[] }
```

#### Acceptance Criteria
- [ ] Extract DOIs from references (format: 10.xxxx/xxxxx)
- [ ] Verify DOI exists via CrossRef API
- [ ] Compare metadata from DOI with citation text
- [ ] Suggest missing DOIs for articles (CrossRef lookup)
- [ ] Support DataCite DOIs for datasets

---

## Epic 4.5: EPUB ACR Integration

### US-4.5.1: EPUBCheck Integration (5 pts)

#### Context
> 🔬 **RESEARCH DRIVER:** EPUB accessibility must be validated against both technical structure (EPUBCheck) and accessibility standards (Ace). Both tools are industry standard for ebook validation.

#### Prerequisites
- Sprint 3 EPUB audit service complete
- Java runtime available

#### Objective
Integrate EPUBCheck for EPUB structure validation as part of ACR generation workflow.

#### Technical Requirements

```
Create EPUBCheck integration service for ACR workflow.

**Create file: `src/services/epub/epubcheck.service.ts`**

interface EpubCheckResult {
  isValid: boolean;
  epubVersion: '2.0' | '3.0' | '3.2';
  messages: EpubCheckMessage[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    fatalErrors: number;
  };
}

interface EpubCheckMessage {
  id: string;              // e.g., "OPF-073"
  severity: 'FATAL' | 'ERROR' | 'WARNING' | 'INFO' | 'USAGE';
  message: string;
  location: {
    path: string;          // File path within EPUB
    line?: number;
    column?: number;
  };
  suggestion?: string;
}

**Implementation:**

async function runEpubCheck(epubPath: string): Promise<EpubCheckResult> {
  // Run EPUBCheck Java CLI
  // java -jar epubcheck.jar input.epub --json output.json

  const { stdout, stderr } = await execAsync(
    `java -jar ${EPUBCHECK_JAR} "${epubPath}" --json -`
  );

  // Parse JSON output
  // Map to our result structure
}

**EPUBCheck installation:**
- Download epubcheck-5.x.x.zip
- Extract to /opt/epubcheck/
- Set EPUBCHECK_JAR environment variable

**Map EPUBCheck messages to WCAG:**
// Create mapping from EPUBCheck message IDs to WCAG criteria
const EPUBCHECK_WCAG_MAPPING = {
  'HTM-003': '1.3.1',  // Missing heading hierarchy
  'HTM-007': '1.1.1',  // Missing alt text
  // ... etc
};

**Create API endpoint:**
POST /api/v1/epub/validate/structure
Body: { jobId: string }
Response: EpubCheckResult
```

#### Acceptance Criteria
- [ ] Run EPUBCheck (Java CLI) for structure validation
- [ ] Support EPUB 2.x and 3.x formats
- [ ] Parse JSON output for errors, warnings, info
- [ ] Report structural errors with location

---

### US-4.5.2: Ace by DAISY Integration (5 pts)

#### Context
Ace by DAISY is the industry standard for EPUB accessibility checking, validating against WCAG 2.1 and EPUB Accessibility 1.0.

#### Prerequisites
- US-4.5.1 complete

#### Technical Requirements

```
Create Ace by DAISY integration service.

**Create file: `src/services/epub/ace.service.ts`**

interface AceResult {
  conformance: {
    'EPUB Accessibility 1.0'?: ConformanceStatus;
    'WCAG 2.1 Level A'?: ConformanceStatus;
    'WCAG 2.1 Level AA'?: ConformanceStatus;
  };
  violations: AceViolation[];
  metadata: {
    conformsTo: string[];
    accessMode: string[];
    accessModeSufficient: string[];
    accessibilityFeature: string[];
    accessibilityHazard: string[];
    accessibilitySummary?: string;
  };
  data: {
    images: ImageData[];
    headings: HeadingData[];
  };
  report: {
    htmlPath: string;
    jsonPath: string;
  };
}

type ConformanceStatus = 'pass' | 'fail' | 'undetermined';

interface AceViolation {
  id: string;
  rule: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  wcagCriterion?: string;
  impact: string;
  description: string;
  help: string;
  location: {
    file: string;
    cfi?: string;         // EPUB Canonical Fragment Identifier
  };
  html?: string;          // Relevant HTML snippet
}

**Implementation:**

async function runAce(epubPath: string): Promise<AceResult> {
  // Create output directory
  const outDir = path.join(TEMP_DIR, uuid());

  // Run Ace
  // npx @daisy/ace epubPath --outdir outDir
  await execAsync(
    `npx @daisy/ace "${epubPath}" --outdir "${outDir}" --force`
  );

  // Parse ace-report.json
  const reportPath = path.join(outDir, 'ace-report.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf-8'));

  // Map to our structure
  return mapAceReport(report);
}

**Combine EPUBCheck and Ace results:**

async function fullEpubValidation(epubPath: string): Promise<CombinedEpubValidation> {
  const [epubCheck, ace] = await Promise.all([
    runEpubCheck(epubPath),
    runAce(epubPath)
  ]);

  // Merge and deduplicate issues
  // Create unified report
}

**Create API endpoint:**
POST /api/v1/epub/validate/accessibility
Body: { jobId: string }
Response: AceResult
```

#### Acceptance Criteria
- [ ] Run Ace (@daisy/ace) for accessibility checking
- [ ] Check WCAG 2.1 violations
- [ ] Check EPUB Accessibility 1.0 conformance
- [ ] Extract accessibility metadata

---

### US-4.5.3: EPUB-Specific ACR Sections (5 pts)

#### Context
> 🔬 **RESEARCH DRIVER:** Ebook procurement requires documentation of reading system compatibility. EPUB Accessibility 1.0 conformance must be explicitly stated in ACRs.

#### Prerequisites
- US-4.5.1 and US-4.5.2 complete
- Sprint 3 ACR generation complete

#### Objective
Add EPUB-specific sections to ACR generation including reading system compatibility matrix.

#### Technical Requirements

```
Extend ACR generator with EPUB-specific sections.

**Create file: `src/services/acr/epub-acr-sections.service.ts`**

interface EpubAcrSections {
  epubAccessibility: EpubAccessibilitySection;
  readingSystemCompatibility: ReadingSystemMatrix;
  mediaOverlays?: MediaOverlaySection;
  navigation: NavigationSection;
}

interface EpubAccessibilitySection {
  conformsTo: string[];          // EPUB Accessibility 1.0, WCAG 2.1 AA
  accessMode: string[];
  accessModeSufficient: string[];
  accessibilityFeature: string[];
  accessibilityHazard: string[];
  accessibilitySummary: string;
  certifiedBy?: string;
  certifierCredential?: string;
}

interface ReadingSystemMatrix {
  testedSystems: ReadingSystemTest[];
  notes: string;
}

interface ReadingSystemTest {
  readingSystem: string;         // e.g., "Apple Books 6.2 (iOS 17)"
  platform: string;              // e.g., "iOS"
  version: string;
  testDate: Date;
  results: {
    basicNavigation: TestResult;
    tocNavigation: TestResult;
    screenReaderCompatibility: TestResult;
    textToSpeech: TestResult;
    fontCustomization: TestResult;
    colorAdjustment: TestResult;
    mediaOverlays?: TestResult;
  };
  notes?: string;
}

type TestResult = 'pass' | 'partial' | 'fail' | 'not_tested' | 'not_applicable';

interface MediaOverlaySection {
  hasMediaOverlays: boolean;
  overlayType?: 'full' | 'partial';
  audioFormat?: string;
  synchronization: 'word' | 'sentence' | 'paragraph';
  playbackSupport: string[];
}

interface NavigationSection {
  hasNcx: boolean;
  hasNav: boolean;
  hasToc: boolean;
  hasPageList: boolean;
  hasLandmarks: boolean;
  pageListComplete: boolean;
  pageSource?: string;           // "print" or "epub"
}

**Reading systems to test:**
const COMMON_READING_SYSTEMS = [
  { name: 'Apple Books', platforms: ['iOS', 'macOS'] },
  { name: 'Google Play Books', platforms: ['Android', 'Web'] },
  { name: 'Kindle', platforms: ['iOS', 'Android', 'Kindle'] },
  { name: 'Kobo', platforms: ['iOS', 'Android', 'Kobo'] },
  { name: 'Adobe Digital Editions', platforms: ['Windows', 'macOS'] },
  { name: 'Thorium Reader', platforms: ['Windows', 'macOS', 'Linux'] },
  { name: 'VoiceOver + Books', platforms: ['iOS'] },
  { name: 'TalkBack + Play Books', platforms: ['Android'] },
];

**Add to ACR template:**

function generateEpubAcrSection(
  epubValidation: CombinedEpubValidation,
  manualTests?: ReadingSystemMatrix
): string {
  // Generate EPUB Accessibility 1.0 conformance section
  // Include reading system compatibility matrix
  // Add media overlay section if present
  // Include navigation accessibility section
}

**Create API endpoint:**
PUT /api/v1/acr/:acrId/epub-sections
Body: { epubSections: EpubAcrSections }
Response: { success: boolean }

GET /api/v1/acr/:acrId/reading-system-template
Response: { template: ReadingSystemMatrix }
```

#### Acceptance Criteria
- [ ] Include EPUB Accessibility 1.0 conformance section
- [ ] Include reading system compatibility matrix
- [ ] Document media overlay accessibility (if present)
- [ ] Document navigation accessibility (NCX/Nav)
- [ ] Distinguish automated vs manual checks with confidence levels

---

### US-4.5.4: ONIX Accessibility Metadata Mapping (2 pts)

#### Context
EPUB accessibility metadata should be included in ONIX feeds for catalog distribution.

#### Prerequisites
- US-4.3.1 (ONIX Generation) complete
- US-4.5.2 (Ace Integration) complete

#### Technical Requirements

```
Create ONIX accessibility metadata mapper.

**Create file: `src/services/onix/accessibility-mapper.service.ts`**

// ONIX List 196: E-publication accessibility detail
const ONIX_LIST_196 = {
  '00': 'Accessibility summary available',
  '01': 'LIA Compliance Scheme',
  '02': 'Accessibility certification',
  '03': 'All textual content can be modified',
  '04': 'Accessible reading sequence',
  '05': 'Short alt text descriptions',
  '06': 'Full alt text descriptions',
  '07': 'Accessible visual alternatives',
  '08': 'Figures have captions',
  '09': 'Tables have captions',
  '10': 'Accessible navigation',
  '11': 'Linked TOC',
  '12': 'NCX navigation',
  '13': 'EPUB 3 navigation',
  '14': 'Index navigation',
  '15': 'Page list navigation',
  '16': 'Reading order',
  '17': 'Synchronised pre-recorded audio',
  '18': 'Text-to-speech hinted',
  '19': 'Dyslexia readability',
  '20': 'Mathematical content accessible',
  '21': 'Chemical content accessible',
  '22': 'Print-equivalent page numbering',
  '93': 'Unknown accessibility',
  '94': 'Inaccessible',
  '95': 'No accessibility features',
  '96': 'Not applicable',
  '97': 'Accessibility summary',
  '98': 'EPUB Accessibility Specification 1.0 A',
  '99': 'EPUB Accessibility Specification 1.0 AA',
};

interface OnixAccessibilityMetadata {
  productFormFeatures: OnixProductFormFeature[];
  accessibilitySummary?: string;
}

interface OnixProductFormFeature {
  productFormFeatureType: '09';  // Accessibility detail
  productFormFeatureValue: string;  // Code from List 196
  productFormFeatureDescription?: string;
}

function mapEpubToOnixAccessibility(
  epubMetadata: EpubAccessibilityMetadata
): OnixAccessibilityMetadata {
  const features: OnixProductFormFeature[] = [];

  // Map accessibilityFeature to List 196
  if (epubMetadata.accessibilityFeature.includes('alternativeText')) {
    features.push({ productFormFeatureType: '09', productFormFeatureValue: '05' });
  }
  if (epubMetadata.accessibilityFeature.includes('longDescription')) {
    features.push({ productFormFeatureType: '09', productFormFeatureValue: '06' });
  }
  if (epubMetadata.accessibilityFeature.includes('tableOfContents')) {
    features.push({ productFormFeatureType: '09', productFormFeatureValue: '11' });
  }
  // ... more mappings

  // Map conformance level
  if (epubMetadata.conformsTo.includes('WCAG 2.1 Level AA')) {
    features.push({ productFormFeatureType: '09', productFormFeatureValue: '99' });
  }

  return { productFormFeatures: features, accessibilitySummary: epubMetadata.accessibilitySummary };
}

**Update ONIX generator:**

function addAccessibilityToOnix(
  onixDoc: OnixDocument,
  accessibilityMetadata: OnixAccessibilityMetadata
): void {
  // Add ProductFormFeature elements to DescriptiveDetail
  // Add accessibility summary to CollateralDetail
}

**Create API endpoint:**
POST /api/v1/onix/:jobId/add-accessibility
Body: { source: 'epub-metadata' | 'manual' }
Response: { addedFeatures: OnixProductFormFeature[] }
```

#### Acceptance Criteria
- [ ] Map EPUB accessibility features to ONIX List 196 codes
- [ ] Map accessMode, accessibilityFeature, accessibilityHazard
- [ ] Generate ONIX ProductFormFeature elements
- [ ] Include accessibilitySummary in ONIX

---

## Sprint 4 Execution Checklist

### Week 8 (Jan 10-17)
- [ ] US-4.1.1: PDF Metadata Extraction
- [ ] US-4.1.2: EPUB Metadata Extraction
- [ ] US-4.1.3: Metadata Normalization
- [ ] US-4.2.1: BISAC Category Suggestions
- [ ] US-4.2.2: Keyword Extraction
- [ ] US-4.2.3: AI Description Generation
- [ ] US-4.3.1: ONIX 3.0 Message Generation
- [ ] US-4.3.2: Retailer-Specific Templates

### Week 9 (Jan 18-24)
- [ ] US-4.3.3: ONIX Validation
- [ ] US-4.3.4: ONIX 2.1 Export
- [ ] US-4.3.5: CSV/Spreadsheet Export
- [ ] US-4.4.1: Reference Extraction
- [ ] US-4.4.2: Citation Format Validation
- [ ] US-4.4.3: DOI Verification
- [ ] US-4.5.1: EPUBCheck Integration
- [ ] US-4.5.2: Ace by DAISY Integration
- [ ] US-4.5.3: EPUB-Specific ACR Sections
- [ ] US-4.5.4: ONIX Accessibility Metadata Mapping

---

## Summary

| Epic | Stories | Points |
|------|---------|--------|
| 4.1 Metadata Extraction | 3 | 18 |
| 4.2 AI Enrichment | 3 | 21 |
| 4.3 ONIX Generation | 5 | 29 |
| 4.4 Citation Validation | 3 | 20 |
| 4.5 EPUB ACR Integration | 4 | 17 |
| **Total** | **18** | **105** |

*Note: Buffer of 5 points recommended.*

---

*End of Sprint 4 Replit Prompts v4.0*
