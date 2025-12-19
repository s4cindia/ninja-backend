import { Request, Response } from 'express';
import { photoAltGenerator } from '../services/alt-text/photo-alt-generator.service';
import { contextExtractor } from '../services/alt-text/context-extractor.service';
import { chartDiagramGenerator } from '../services/alt-text/chart-diagram-generator.service';
import { longDescriptionGenerator } from '../services/alt-text/long-description-generator.service';
import prisma from '../lib/prisma';
import fs from 'fs/promises';
import path from 'path';

export const altTextController = {
  async generate(req: Request, res: Response) {
    try {
      const { imageId, jobId } = req.body;
      
      if (!imageId || !jobId) {
        return res.status(400).json({ 
          success: false, 
          error: 'imageId and jobId are required' 
        });
      }
      
      const file = await prisma.file.findFirst({
        where: { id: imageId }
      });
      
      if (!file) {
        return res.status(404).json({ 
          success: false, 
          error: 'Image not found' 
        });
      }
      
      const imageBuffer = await fs.readFile(file.path);
      
      const result = await photoAltGenerator.generateAltText(
        imageBuffer,
        file.mimeType || 'image/jpeg'
      );
      result.imageId = imageId;
      
      const saved = await prisma.generatedAltText.create({
        data: {
          imageId,
          jobId,
          shortAlt: result.shortAlt,
          extendedAlt: result.extendedAlt,
          confidence: result.confidence,
          flags: result.flags,
          aiModel: result.aiModel,
          status: photoAltGenerator.needsHumanReview(result) ? 'needs_review' : 'pending',
        },
      });
      
      res.json({
        success: true,
        data: {
          ...result,
          id: saved.id,
          needsReview: photoAltGenerator.needsHumanReview(result),
        },
      });
    } catch (error) {
      console.error('Alt text generation failed:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to generate alt text' 
      });
    }
  },

  async generateFromBuffer(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Image file is required'
        });
      }

      const result = await photoAltGenerator.generateAltText(
        req.file.buffer,
        req.file.mimetype || 'image/jpeg'
      );

      res.json({
        success: true,
        data: {
          ...result,
          needsReview: photoAltGenerator.needsHumanReview(result),
        },
      });
    } catch (error) {
      console.error('Alt text generation from buffer failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate alt text'
      });
    }
  },

  async generateForJob(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      
      const job = await prisma.job.findUnique({
        where: { id: jobId },
      });
      
      if (!job) {
        return res.status(404).json({ 
          success: false, 
          error: 'Job not found' 
        });
      }
      
      interface ExtractedImage { id?: string; path?: string; mimeType?: string }
      const jobOutput = job.output as { extractedImages?: ExtractedImage[] } | null;
      const extractedImages = jobOutput?.extractedImages || [];
      
      if (extractedImages.length === 0) {
        return res.json({
          success: true,
          data: {
            total: 0,
            generated: 0,
            needsReview: 0,
            results: [],
          },
        });
      }
      
      const images: Array<{ id: string; buffer: Buffer; mimeType: string }> = [];
      
      for (const img of extractedImages) {
        try {
          if (img.path) {
            const buffer = await fs.readFile(img.path);
            images.push({
              id: img.id || path.basename(img.path),
              buffer,
              mimeType: img.mimeType || 'image/jpeg',
            });
          }
        } catch (err) {
          console.error(`Failed to read image ${img.id}:`, err);
        }
      }
      
      if (images.length === 0) {
        return res.json({
          success: true,
          data: {
            total: extractedImages.length,
            generated: 0,
            needsReview: 0,
            results: [],
            error: 'No valid images found to process',
          },
        });
      }
      
      const results = await photoAltGenerator.generateBatch(images);
      
      await Promise.all(
        results.map(result =>
          prisma.generatedAltText.create({
            data: {
              imageId: result.imageId,
              jobId,
              shortAlt: result.shortAlt,
              extendedAlt: result.extendedAlt || '',
              confidence: result.confidence,
              flags: result.flags,
              aiModel: result.aiModel,
              status: photoAltGenerator.needsHumanReview(result) ? 'needs_review' : 'pending',
            },
          })
        )
      );
      
      const needsReview = results.filter(r => photoAltGenerator.needsHumanReview(r));
      
      res.json({
        success: true,
        data: {
          total: results.length,
          generated: results.filter(r => r.shortAlt).length,
          needsReview: needsReview.length,
          results,
        },
      });
    } catch (error) {
      console.error('Batch alt text generation failed:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to generate alt text for job' 
      });
    }
  },

  async getForJob(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const { status } = req.query;
      
      const where: { jobId: string; status?: string } = { jobId };
      if (status) {
        where.status = status as string;
      }
      
      const altTexts = await prisma.generatedAltText.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      
      res.json({
        success: true,
        data: altTexts,
      });
    } catch (error) {
      console.error('Failed to get alt texts:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get alt texts' 
      });
    }
  },

  async updateAltText(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { approvedAlt, status } = req.body;
      const userId = (req as Request & { user?: { id: string } }).user?.id;

      const altText = await prisma.generatedAltText.findUnique({
        where: { id }
      });

      if (!altText) {
        return res.status(404).json({
          success: false,
          error: 'Alt text not found'
        });
      }

      const updated = await prisma.generatedAltText.update({
        where: { id },
        data: {
          ...(approvedAlt && { approvedAlt }),
          ...(status && { status }),
          ...(status === 'approved' || status === 'edited' ? {
            approvedBy: userId,
            approvedAt: new Date()
          } : {})
        }
      });

      res.json({
        success: true,
        data: updated
      });
    } catch (error) {
      console.error('Failed to update alt text:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update alt text'
      });
    }
  },

  async generateContextual(req: Request, res: Response) {
    try {
      const { imageId, jobId } = req.body;
      
      if (!imageId || !jobId) {
        return res.status(400).json({ 
          success: false, 
          error: 'imageId and jobId are required' 
        });
      }
      
      const file = await prisma.file.findFirst({
        where: { id: imageId }
      });
      
      if (!file) {
        return res.status(404).json({ 
          success: false, 
          error: 'Image not found' 
        });
      }
      
      const imageBuffer = await fs.readFile(file.path);
      
      const context = await contextExtractor.extractContext(jobId, imageId);
      
      const { contextAware, standalone } = await photoAltGenerator.generateContextAwareAltText(
        imageBuffer,
        file.mimeType || 'image/jpeg',
        context
      );
      
      contextAware.imageId = imageId;
      standalone.imageId = imageId;
      
      const saved = await prisma.generatedAltText.create({
        data: {
          imageId,
          jobId,
          shortAlt: contextAware.shortAlt,
          extendedAlt: contextAware.extendedAlt || '',
          confidence: contextAware.confidence,
          flags: contextAware.flags,
          aiModel: contextAware.aiModel,
          status: photoAltGenerator.needsHumanReview(contextAware) ? 'needs_review' : 'pending',
        },
      });
      
      res.json({
        success: true,
        data: {
          contextAware: {
            ...contextAware,
            id: saved.id,
          },
          standalone,
          context,
          needsReview: photoAltGenerator.needsHumanReview(contextAware),
        },
      });
    } catch (error) {
      console.error('Context-aware alt text generation failed:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to generate context-aware alt text' 
      });
    }
  },

  async generateChartDescription(req: Request, res: Response) {
    try {
      const { imageId, jobId } = req.body;
      
      if (!imageId || !jobId) {
        return res.status(400).json({ 
          success: false, 
          error: 'imageId and jobId are required' 
        });
      }
      
      const file = await prisma.file.findFirst({
        where: { id: imageId }
      });
      
      if (!file) {
        return res.status(404).json({ 
          success: false, 
          error: 'Image not found' 
        });
      }
      
      const imageBuffer = await fs.readFile(file.path);
      
      const result = await chartDiagramGenerator.generateChartDescription(
        imageBuffer,
        file.mimeType || 'image/jpeg'
      );
      result.imageId = imageId;
      
      const saved = await prisma.generatedAltText.create({
        data: {
          imageId,
          jobId,
          shortAlt: result.shortAlt,
          extendedAlt: result.longDescription,
          confidence: result.confidence,
          flags: result.flags,
          aiModel: result.aiModel,
          status: result.confidence < 70 ? 'needs_review' : 'pending',
        },
      });
      
      res.json({
        success: true,
        data: {
          ...result,
          id: saved.id,
          needsLongDescription: chartDiagramGenerator.needsLongDescription(result),
        },
      });
    } catch (error) {
      console.error('Chart description generation failed:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to generate chart description' 
      });
    }
  },

  async classifyImage(req: Request, res: Response) {
    try {
      const { imageId, jobId } = req.body;
      
      if (!imageId || !jobId) {
        return res.status(400).json({ 
          success: false, 
          error: 'imageId and jobId are required' 
        });
      }
      
      const file = await prisma.file.findFirst({
        where: { id: imageId }
      });
      
      if (!file) {
        return res.status(404).json({ 
          success: false, 
          error: 'Image not found' 
        });
      }
      
      const imageBuffer = await fs.readFile(file.path);
      
      const imageType = await chartDiagramGenerator.classifyImage(
        imageBuffer,
        file.mimeType || 'image/jpeg'
      );
      
      res.json({
        success: true,
        data: {
          imageId,
          imageType,
          needsSpecializedDescription: imageType !== 'PHOTO' && imageType !== 'UNKNOWN',
        },
      });
    } catch (error) {
      console.error('Image classification failed:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to classify image' 
      });
    }
  },

  async getReviewQueue(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const { status, minConfidence, maxConfidence, flags } = req.query;
      
      interface WhereClause {
        jobId: string;
        status?: string;
        confidence?: { gte?: number; lte?: number };
        flags?: { hasSome: string[] };
      }
      const where: WhereClause = { jobId };
      
      if (status) {
        where.status = status as string;
      }
      
      if (minConfidence || maxConfidence) {
        where.confidence = {};
        if (minConfidence) where.confidence.gte = parseFloat(minConfidence as string);
        if (maxConfidence) where.confidence.lte = parseFloat(maxConfidence as string);
      }
      
      if (flags) {
        const flagList = (flags as string).split(',');
        where.flags = { hasSome: flagList };
      }
      
      const items = await prisma.generatedAltText.findMany({
        where,
        orderBy: [
          { confidence: 'asc' },
          { createdAt: 'desc' },
        ],
      });
      
      const allItems = await prisma.generatedAltText.findMany({ where: { jobId } });
      const stats = {
        total: allItems.length,
        pending: allItems.filter(i => i.status === 'pending').length,
        needsReview: allItems.filter(i => i.status === 'needs_review').length,
        approved: allItems.filter(i => i.status === 'approved').length,
        edited: allItems.filter(i => i.status === 'edited').length,
        rejected: allItems.filter(i => i.status === 'rejected').length,
      };
      
      res.json({
        success: true,
        data: {
          items,
          stats,
          pendingReview: stats.needsReview + stats.pending,
        },
      });
    } catch (error) {
      console.error('Failed to get review queue:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get review queue' 
      });
    }
  },

  async approve(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { approvedAlt } = req.body;
      const userId = (req as Request & { user?: { id: string } }).user?.id || 'system';
      
      const existing = await prisma.generatedAltText.findUnique({
        where: { id },
      });
      
      if (!existing) {
        return res.status(404).json({ 
          success: false, 
          error: 'Alt text record not found' 
        });
      }
      
      const isEdited = approvedAlt && approvedAlt !== existing.shortAlt;
      
      const updated = await prisma.generatedAltText.update({
        where: { id },
        data: {
          status: isEdited ? 'edited' : 'approved',
          approvedAlt: approvedAlt || existing.shortAlt,
          approvedBy: userId,
          approvedAt: new Date(),
        },
      });
      
      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      console.error('Failed to approve alt text:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to approve alt text' 
      });
    }
  },

  async reject(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as Request & { user?: { id: string } }).user?.id || 'system';
      
      const updated = await prisma.generatedAltText.update({
        where: { id },
        data: {
          status: 'rejected',
          approvedBy: userId,
          approvedAt: new Date(),
        },
      });
      
      res.json({
        success: true,
        data: updated,
        message: 'Alt text rejected. Regenerate or provide manual alt text.',
      });
    } catch (error) {
      console.error('Failed to reject alt text:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to reject alt text' 
      });
    }
  },

  async regenerate(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { additionalContext, useContextAware } = req.body;
      
      const existing = await prisma.generatedAltText.findUnique({
        where: { id },
      });
      
      if (!existing) {
        return res.status(404).json({ 
          success: false, 
          error: 'Alt text record not found' 
        });
      }
      
      const file = await prisma.file.findFirst({
        where: { id: existing.imageId }
      });
      
      if (!file) {
        return res.status(404).json({ 
          success: false, 
          error: 'Image not found' 
        });
      }
      
      const imageBuffer = await fs.readFile(file.path);
      let result;
      
      if (useContextAware) {
        const context = await contextExtractor.extractContext(existing.jobId, existing.imageId);
        if (additionalContext) {
          context.textBefore = additionalContext + '\n' + context.textBefore;
        }
        const { contextAware } = await photoAltGenerator.generateContextAwareAltText(
          imageBuffer,
          file.mimeType || 'image/jpeg',
          context
        );
        result = contextAware;
      } else {
        result = await photoAltGenerator.generateAltText(
          imageBuffer,
          file.mimeType || 'image/jpeg'
        );
      }
      
      const updated = await prisma.generatedAltText.update({
        where: { id },
        data: {
          shortAlt: result.shortAlt,
          extendedAlt: result.extendedAlt || '',
          confidence: result.confidence,
          flags: [...result.flags, 'REGENERATED'],
          status: photoAltGenerator.needsHumanReview(result) ? 'needs_review' : 'pending',
          approvedAlt: null,
          approvedBy: null,
          approvedAt: null,
        },
      });
      
      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      console.error('Failed to regenerate alt text:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to regenerate alt text' 
      });
    }
  },

  async batchApprove(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const { minConfidence = 85, ids } = req.body;
      const userId = (req as Request & { user?: { id: string } }).user?.id || 'system';
      
      interface BatchWhereClause {
        jobId: string;
        id?: { in: string[] };
        confidence?: { gte: number };
        status?: { in: string[] };
        NOT?: { flags: { hasSome: string[] } };
      }
      const where: BatchWhereClause = { jobId };
      
      if (ids && ids.length > 0) {
        where.id = { in: ids };
      } else {
        where.confidence = { gte: minConfidence };
        where.status = { in: ['pending', 'needs_review'] };
        where.NOT = {
          flags: { hasSome: ['FACE_DETECTED', 'SENSITIVE_CONTENT', 'LOW_CONFIDENCE'] }
        };
      }
      
      const result = await prisma.generatedAltText.updateMany({
        where,
        data: {
          status: 'approved',
          approvedBy: userId,
          approvedAt: new Date(),
        },
      });
      
      res.json({
        success: true,
        data: {
          approved: result.count,
          message: `Batch approved ${result.count} items`,
        },
      });
    } catch (error) {
      console.error('Failed to batch approve:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to batch approve' 
      });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      
      const altText = await prisma.generatedAltText.findUnique({
        where: { id },
      });
      
      if (!altText) {
        return res.status(404).json({ 
          success: false, 
          error: 'Alt text record not found' 
        });
      }
      
      const thumbnailUrl = `/api/v1/images/${altText.jobId}/${altText.imageId}/thumbnail`;
      
      res.json({
        success: true,
        data: {
          ...altText,
          thumbnailUrl,
          needsReview: ['pending', 'needs_review'].includes(altText.status),
        },
      });
    } catch (error) {
      console.error('Failed to get alt text:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get alt text' 
      });
    }
  },

  async checkLongDescriptionNeeded(req: Request, res: Response) {
    try {
      const { id } = req.params;
      
      const altText = await prisma.generatedAltText.findUnique({
        where: { id },
      });
      
      if (!altText) {
        return res.status(404).json({ 
          success: false, 
          error: 'Alt text record not found' 
        });
      }
      
      const imageType = altText.flags.find(f => 
        ['BAR_CHART', 'LINE_CHART', 'PIE_CHART', 'FLOWCHART', 'DIAGRAM', 'TABLE_IMAGE'].includes(f)
      ) || 'PHOTO';
      
      const result = longDescriptionGenerator.needsLongDescription(
        imageType,
        altText.flags,
        altText.shortAlt.length
      );
      
      res.json({
        success: true,
        data: {
          imageId: altText.imageId,
          altTextId: id,
          ...result,
        },
      });
    } catch (error) {
      console.error('Failed to check long description need:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to check long description need' 
      });
    }
  },

  async generateLongDescription(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { trigger = 'MANUAL_REQUEST' } = req.body;
      
      const altText = await prisma.generatedAltText.findUnique({
        where: { id },
      });
      
      if (!altText) {
        return res.status(404).json({ 
          success: false, 
          error: 'Alt text record not found' 
        });
      }
      
      const file = await prisma.file.findFirst({
        where: { id: altText.imageId }
      });
      
      if (!file) {
        return res.status(404).json({ 
          success: false, 
          error: 'Image not found' 
        });
      }
      
      const imageBuffer = await fs.readFile(file.path);
      
      const result = await longDescriptionGenerator.generateLongDescription(
        imageBuffer,
        file.mimeType || 'image/jpeg',
        trigger,
        altText.shortAlt
      );
      
      const saved = await prisma.longDescription.create({
        data: {
          imageId: altText.imageId,
          jobId: altText.jobId,
          altTextId: id,
          trigger,
          plainText: result.content.plainText,
          markdown: result.content.markdown,
          html: result.content.html,
          wordCount: result.wordCount,
          sections: result.sections || [],
          aiModel: result.aiModel,
        },
      });
      
      res.json({
        success: true,
        data: {
          ...result,
          id: saved.id,
        },
      });
    } catch (error) {
      console.error('Failed to generate long description:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to generate long description' 
      });
    }
  },

  async getLongDescription(req: Request, res: Response) {
    try {
      const { id } = req.params;
      
      const longDesc = await prisma.longDescription.findFirst({
        where: { altTextId: id },
        orderBy: { createdAt: 'desc' },
      });
      
      if (!longDesc) {
        return res.status(404).json({ 
          success: false, 
          error: 'Long description not found' 
        });
      }
      
      const altText = await prisma.generatedAltText.findUnique({
        where: { id },
      });
      
      const ariaMarkup = longDescriptionGenerator.generateAriaMarkup(
        longDesc.imageId,
        altText?.shortAlt || '',
        {
          id: longDesc.id,
          imageId: longDesc.imageId,
          jobId: longDesc.jobId,
          content: {
            html: longDesc.html,
            plainText: longDesc.plainText,
            markdown: longDesc.markdown,
          },
          wordCount: longDesc.wordCount,
          sections: longDesc.sections as { heading: string; content: string }[] | undefined,
          generatedAt: longDesc.createdAt,
          aiModel: longDesc.aiModel,
        }
      );
      
      res.json({
        success: true,
        data: {
          ...longDesc,
          ariaMarkup,
        },
      });
    } catch (error) {
      console.error('Failed to get long description:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get long description' 
      });
    }
  },

  async updateLongDescription(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { plainText, markdown, html, status } = req.body;
      const userId = (req as Request & { user?: { id: string } }).user?.id || 'system';
      
      interface LongDescUpdateData {
        updatedAt: Date;
        plainText?: string;
        markdown?: string;
        html?: string;
        status?: string;
        approvedBy?: string;
        approvedAt?: Date;
        wordCount?: number;
      }
      const updateData: LongDescUpdateData = { updatedAt: new Date() };
      
      if (plainText) updateData.plainText = plainText;
      if (markdown) updateData.markdown = markdown;
      if (html) updateData.html = html;
      if (status) {
        updateData.status = status;
        if (status === 'approved') {
          updateData.approvedBy = userId;
          updateData.approvedAt = new Date();
        }
      }
      
      if (plainText) {
        updateData.wordCount = plainText.split(/\s+/).filter((w: string) => w.length > 0).length;
      }
      
      const updated = await prisma.longDescription.update({
        where: { id },
        data: updateData,
      });
      
      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      console.error('Failed to update long description:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to update long description' 
      });
    }
  }
};
