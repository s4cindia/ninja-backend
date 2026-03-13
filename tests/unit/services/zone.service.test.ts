import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCreate = vi.fn();
const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    zone: {
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    $transaction: vi.fn(async (fnOrArr: unknown) => {
      if (typeof fnOrArr === 'function') {
        // Interactive transaction — call with a proxy that delegates to the same mocks
        const tx = {
          zone: {
            create: (...args: unknown[]) => mockCreate(...args),
            findMany: (...args: unknown[]) => mockFindMany(...args),
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
          },
        };
        return (fnOrArr as (tx: typeof tx) => Promise<unknown>)(tx);
      }
      // Batch transaction — execute all promises
      return Promise.all(fnOrArr as Promise<unknown>[]);
    }),
  },
  Prisma: {
    JsonNull: 'DbNull',
  },
}));

import { zoneService } from '../../../src/services/zone.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ZoneService', () => {
  describe('createTableZone', () => {
    it('creates parent + THEAD + TBODY children in a transaction', async () => {
      const parentZone = {
        id: 'parent-1',
        fileId: 'file-1',
        tenantId: 'tenant-1',
        pageNumber: 1,
        type: 'TABLE',
      };
      const theadZone = {
        id: 'thead-1',
        zoneSubtype: 'THEAD',
        parentZoneId: 'parent-1',
        rowCount: 1,
        tableStructure: { rows: [{ cells: [{ type: 'TH', content: '', colspan: 1, rowspan: 1, align: 'left' }] }] },
      };
      const tbodyZone = {
        id: 'tbody-1',
        zoneSubtype: 'TBODY',
        parentZoneId: 'parent-1',
        rowCount: 1,
        tableStructure: { rows: [{ cells: [{ type: 'TD', content: '', colspan: 1, rowspan: 1, align: 'left' }] }] },
      };

      mockCreate
        .mockResolvedValueOnce(parentZone)
        .mockResolvedValueOnce(theadZone)
        .mockResolvedValueOnce(tbodyZone);

      const result = await zoneService.createTableZone('file-1', 'tenant-1', 1);

      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(result.id).toBe('parent-1');
      expect(result.children).toHaveLength(2);
      expect(result.children[0].zoneSubtype).toBe('THEAD');
      expect(result.children[1].zoneSubtype).toBe('TBODY');

      // Verify parent was created with type TABLE
      expect(mockCreate.mock.calls[0][0].data.type).toBe('TABLE');
      // Verify children reference parent
      expect(mockCreate.mock.calls[1][0].data.parentZoneId).toBe('parent-1');
      expect(mockCreate.mock.calls[2][0].data.parentZoneId).toBe('parent-1');
    });
  });

  describe('getZones', () => {
    it('returns children array on TABLE zones', async () => {
      const zones = [
        {
          id: 'zone-1',
          type: 'P',
          fileId: 'file-1',
          pageNumber: 1,
          childZones: [],
        },
        {
          id: 'zone-2',
          type: 'TABLE',
          fileId: 'file-1',
          pageNumber: 1,
          childZones: [
            { id: 'thead-1', zoneSubtype: 'THEAD', rowCount: 1, tableStructure: {} },
            { id: 'tbody-1', zoneSubtype: 'TBODY', rowCount: 2, tableStructure: {} },
          ],
        },
      ];

      mockFindMany.mockResolvedValue(zones);

      const result = await zoneService.getZones('file-1', 'tenant-1');

      expect(result).toHaveLength(2);
      // P zone should not have children or childZones
      expect(result[0]).not.toHaveProperty('children');
      expect(result[0]).not.toHaveProperty('childZones');
      // TABLE zone should have children
      const tableZone = result[1] as Record<string, unknown>;
      expect(tableZone.children).toHaveLength(2);
      expect(tableZone).not.toHaveProperty('childZones');
    });

    it('filters by page numbers', async () => {
      mockFindMany.mockResolvedValue([]);

      await zoneService.getZones('file-1', 'tenant-1', [1, 3]);

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            pageNumber: { in: [1, 3] },
            tenantId: 'tenant-1',
          }),
        }),
      );
    });
  });

  describe('updateTableStructure', () => {
    it('updates both children and returns parent with children', async () => {
      const children = [
        { id: 'thead-1', zoneSubtype: 'THEAD', parentZoneId: 'parent-1' },
        { id: 'tbody-1', zoneSubtype: 'TBODY', parentZoneId: 'parent-1' },
      ];
      mockFindMany.mockResolvedValue(children);
      mockUpdate.mockResolvedValue({});

      const parentWithChildren = {
        id: 'parent-1',
        type: 'TABLE',
        childZones: [
          { id: 'thead-1', zoneSubtype: 'THEAD', rowCount: 2, tableStructure: {} },
          { id: 'tbody-1', zoneSubtype: 'TBODY', rowCount: 3, tableStructure: {} },
        ],
      };
      mockFindUnique.mockResolvedValue(parentWithChildren);

      const thead = {
        rows: [
          { cells: [{ type: 'TH' as const, content: 'A', colspan: 1, rowspan: 1, align: 'left' }] },
          { cells: [{ type: 'TH' as const, content: 'B', colspan: 1, rowspan: 1, align: 'left' }] },
        ],
      };
      const tbody = {
        rows: [
          { cells: [{ type: 'TD' as const, content: '1', colspan: 1, rowspan: 1, align: 'left' }] },
          { cells: [{ type: 'TD' as const, content: '2', colspan: 1, rowspan: 1, align: 'left' }] },
          { cells: [{ type: 'TD' as const, content: '3', colspan: 1, rowspan: 1, align: 'left' }] },
        ],
      };

      const result = await zoneService.updateTableStructure('parent-1', 'tenant-1', thead, tbody);

      // Should update both children
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'thead-1' },
          data: expect.objectContaining({ rowCount: 2 }),
        }),
      );
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tbody-1' },
          data: expect.objectContaining({ rowCount: 3 }),
        }),
      );

      // Should return parent with children (not childZones)
      expect(result).toBeDefined();
      expect(result!.children).toHaveLength(2);
    });

    it('throws if children are missing', async () => {
      mockFindMany.mockResolvedValue([]);

      const thead = { rows: [] };
      const tbody = { rows: [] };

      await expect(
        zoneService.updateTableStructure('parent-1', 'tenant-1', thead, tbody),
      ).rejects.toThrow('missing THEAD or TBODY children');
    });
  });
});
