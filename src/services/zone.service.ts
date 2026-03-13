import prisma, { Prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

interface CreateZoneInput {
  tenantId: string;
  fileId: string;
  pageNumber: number;
  type: string;
  label?: string;
  readingOrder?: number;
  bounds?: Prisma.InputJsonValue;
  content?: string;
  altText?: string;
  longDesc?: string;
  tableStructure?: Prisma.InputJsonValue;
  zoneSubtype?: string;
  rowCount?: number;
  parentZoneId?: string;
}

interface UpdateZoneInput {
  type?: string;
  label?: string;
  readingOrder?: number;
  bounds?: Prisma.InputJsonValue;
  content?: string;
  altText?: string;
  longDesc?: string;
  tableStructure?: Prisma.InputJsonValue;
}

interface TableStructure {
  rows: Array<{
    cells: Array<{
      type: 'TH' | 'TD';
      content: string;
      colspan: number;
      rowspan: number;
      align: string;
    }>;
  }>;
}

class ZoneService {
  async createZone(data: CreateZoneInput) {
    return prisma.zone.create({ data });
  }

  async createTableZone(
    fileId: string,
    tenantId: string,
    pageNumber: number,
    bounds?: Prisma.InputJsonValue,
  ) {
    const parent = await prisma.zone.create({
      data: {
        fileId,
        tenantId,
        pageNumber,
        type: 'TABLE',
        bounds: bounds ?? Prisma.JsonNull,
      },
    });

    const defaultTheadStructure = {
      rows: [
        {
          cells: [
            { type: 'TH', content: '', colspan: 1, rowspan: 1, align: 'left' },
          ],
        },
      ],
    };

    const defaultTbodyStructure = {
      rows: [
        {
          cells: [
            { type: 'TD', content: '', colspan: 1, rowspan: 1, align: 'left' },
          ],
        },
      ],
    };

    const [thead, tbody] = await Promise.all([
      prisma.zone.create({
        data: {
          fileId,
          tenantId,
          pageNumber,
          type: 'TABLE',
          zoneSubtype: 'THEAD',
          parentZoneId: parent.id,
          rowCount: 1,
          tableStructure: defaultTheadStructure,
        },
      }),
      prisma.zone.create({
        data: {
          fileId,
          tenantId,
          pageNumber,
          type: 'TABLE',
          zoneSubtype: 'TBODY',
          parentZoneId: parent.id,
          rowCount: 1,
          tableStructure: defaultTbodyStructure,
        },
      }),
    ]);

    return {
      ...parent,
      childZones: [thead, tbody],
    };
  }

  async getZones(fileId: string, pages?: number[]) {
    const where: Prisma.ZoneWhereInput = {
      fileId,
      parentZoneId: null,
    };
    if (pages && pages.length > 0) {
      where.pageNumber = { in: pages };
    }

    const zones = await prisma.zone.findMany({
      where,
      include: {
        childZones: {
          select: {
            id: true,
            zoneSubtype: true,
            rowCount: true,
            tableStructure: true,
          },
        },
      },
      orderBy: [{ pageNumber: 'asc' }, { readingOrder: 'asc' }],
    });

    return zones.map((zone) => {
      if (zone.type === 'TABLE' && zone.childZones.length > 0) {
        return { ...zone, children: zone.childZones };
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { childZones, ...rest } = zone;
      return rest;
    });
  }

  async updateZone(id: string, data: UpdateZoneInput) {
    return prisma.zone.update({
      where: { id },
      data,
    });
  }

  async updateTableStructure(
    zoneId: string,
    thead: TableStructure,
    tbody: TableStructure,
  ) {
    const children = await prisma.zone.findMany({
      where: { parentZoneId: zoneId },
    });

    const theadChild = children.find((c) => c.zoneSubtype === 'THEAD');
    const tbodyChild = children.find((c) => c.zoneSubtype === 'TBODY');

    if (!theadChild || !tbodyChild) {
      throw new Error(`Table zone ${zoneId} is missing THEAD or TBODY children`);
    }

    await Promise.all([
      prisma.zone.update({
        where: { id: theadChild.id },
        data: {
          tableStructure: thead as unknown as Prisma.InputJsonValue,
          rowCount: thead.rows.length,
        },
      }),
      prisma.zone.update({
        where: { id: tbodyChild.id },
        data: {
          tableStructure: tbody as unknown as Prisma.InputJsonValue,
          rowCount: tbody.rows.length,
        },
      }),
    ]);

    return prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        childZones: {
          select: {
            id: true,
            zoneSubtype: true,
            rowCount: true,
            tableStructure: true,
          },
        },
      },
    });
  }

  async migrateExistingTableZones() {
    const tableZones = await prisma.zone.findMany({
      where: {
        type: 'TABLE',
        parentZoneId: null,
      },
      include: { childZones: true },
    });

    const orphans = tableZones.filter((z) => z.childZones.length === 0);
    let migrated = 0;
    let skipped = 0;

    for (const zone of orphans) {
      try {
        const existing = zone.tableStructure as unknown as TableStructure | null;
        let theadStructure: TableStructure;
        let tbodyStructure: TableStructure;

        if (existing?.rows && existing.rows.length > 0) {
          theadStructure = {
            rows: [
              {
                cells: existing.rows[0].cells.map((c) => ({
                  ...c,
                  type: 'TH' as const,
                })),
              },
            ],
          };
          const tbodyRows = existing.rows.slice(1);
          tbodyStructure = {
            rows:
              tbodyRows.length > 0
                ? tbodyRows.map((r) => ({
                    cells: r.cells.map((c) => ({ ...c, type: 'TD' as const })),
                  }))
                : [
                    {
                      cells: [
                        { type: 'TD' as const, content: '', colspan: 1, rowspan: 1, align: 'left' },
                      ],
                    },
                  ],
          };
        } else {
          theadStructure = {
            rows: [{ cells: [{ type: 'TH', content: '', colspan: 1, rowspan: 1, align: 'left' }] }],
          };
          tbodyStructure = {
            rows: [{ cells: [{ type: 'TD', content: '', colspan: 1, rowspan: 1, align: 'left' }] }],
          };
        }

        await Promise.all([
          prisma.zone.create({
            data: {
              fileId: zone.fileId,
              tenantId: zone.tenantId,
              pageNumber: zone.pageNumber,
              type: 'TABLE',
              zoneSubtype: 'THEAD',
              parentZoneId: zone.id,
              rowCount: theadStructure.rows.length,
              tableStructure: theadStructure as unknown as Prisma.InputJsonValue,
            },
          }),
          prisma.zone.create({
            data: {
              fileId: zone.fileId,
              tenantId: zone.tenantId,
              pageNumber: zone.pageNumber,
              type: 'TABLE',
              zoneSubtype: 'TBODY',
              parentZoneId: zone.id,
              rowCount: tbodyStructure.rows.length,
              tableStructure: tbodyStructure as unknown as Prisma.InputJsonValue,
            },
          }),
        ]);

        migrated++;
      } catch (err) {
        logger.warn(`Failed to migrate table zone ${zone.id}:`, err);
        skipped++;
      }
    }

    return { total: orphans.length, migrated, skipped };
  }
}

export const zoneService = new ZoneService();
export { ZoneService };
