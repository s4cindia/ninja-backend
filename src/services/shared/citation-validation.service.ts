import prisma from '../../lib/prisma';

export class CitationValidationService {
  
  static async validateComponentOwnership(
    citationId: string,
    componentId: string
  ): Promise<void> {
    const component = await prisma.citationComponent.findUnique({
      where: { id: componentId },
      select: { id: true, citationId: true }
    });

    if (!component) {
      throw new Error(`CitationComponent not found: ${componentId}`);
    }

    if (component.citationId !== citationId) {
      throw new Error(
        `CitationComponent ${componentId} belongs to Citation ${component.citationId}, ` +
        `not Citation ${citationId}. Cannot set as primary component.`
      );
    }
  }

  static async setPrimaryComponent(
    citationId: string,
    componentId: string
  ) {
    await this.validateComponentOwnership(citationId, componentId);

    return prisma.citation.update({
      where: { id: citationId },
      data: { primaryComponentId: componentId }
    });
  }

  static async clearPrimaryComponent(citationId: string) {
    return prisma.citation.update({
      where: { id: citationId },
      data: { primaryComponentId: null }
    });
  }
}

export const citationValidation = new CitationValidationService();
export default CitationValidationService;
