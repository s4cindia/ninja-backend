const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');

const prisma = new PrismaClient();

async function createTestUser() {
  try {
    // Check if tenant exists, create if not
    let tenant = await prisma.tenant.findFirst({
      where: { slug: 'test-org' }
    });

    if (!tenant) {
      console.log('Creating test tenant...');
      tenant = await prisma.tenant.create({
        data: {
          id: nanoid(),
          name: 'Test Organization',
          slug: 'test-org',
          settings: {},
          updatedAt: new Date(),
        },
      });
      console.log('✅ Tenant created:', tenant.slug);
    } else {
      console.log('✅ Tenant already exists:', tenant.slug);
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email: 'admin@test.com' }
    });

    if (existingUser) {
      console.log('Updating existing user with tenant...');
      await prisma.user.update({
        where: { email: 'admin@test.com' },
        data: {
          tenantId: tenant.id,
          updatedAt: new Date(),
        },
      });
      console.log('✅ User updated with tenant');
    } else {
      console.log('Creating test user...');
      const hashedPassword = await bcrypt.hash('password123', 10);

      const user = await prisma.user.create({
        data: {
          id: nanoid(),
          email: 'admin@test.com',
          password: hashedPassword,
          firstName: 'Admin',
          lastName: 'User',
          role: 'ADMIN',
          tenantId: tenant.id,
          updatedAt: new Date(),
        },
      });
      console.log('✅ User created:', user.email);
    }

    console.log('\nTest credentials:');
    console.log('Email: admin@test.com');
    console.log('Password: password123');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestUser();
