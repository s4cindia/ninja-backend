const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function verifySwap() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId }
  });

  if (!doc) {
    console.log('Document not found!');
    return;
  }

  const originalPath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const modifiedPath = path.join(process.cwd(), 'test-output-modified.docx');

  console.log('=== ORIGINAL DOCUMENT ===');
  const originalBuffer = await fs.readFile(originalPath);
  const originalText = await mammoth.extractRawText({ buffer: originalBuffer });

  // Extract the Introduction paragraph
  const introMatch = originalText.value.match(/Introduction[\s\S]*?References/);
  if (introMatch) {
    console.log(introMatch[0].substring(0, 500));
  }

  console.log('\n=== MODIFIED DOCUMENT ===');
  const modifiedBuffer = await fs.readFile(modifiedPath);
  const modifiedText = await mammoth.extractRawText({ buffer: modifiedBuffer });

  const introMatch2 = modifiedText.value.match(/Introduction[\s\S]*?References/);
  if (introMatch2) {
    console.log(introMatch2[0].substring(0, 500));
  }

  await prisma.$disconnect();
}

verifySwap().catch(console.error);
