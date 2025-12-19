import { Request, Response } from 'express';
import { photoAltGenerator } from '../services/alt-text/photo-alt-generator.service';
import { contextExtractor } from '../services/alt-text/context-extractor.service';
import { chartDiagramGenerator } from '../services/alt-text/chart-diagram-generator.service';
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
      
      const jobOutput = job.output as any;
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
      
      const where: any = { jobId };
      if (status) {
        where.status = status;
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
      const userId = (req as any).user?.id;

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
  }
};
