import jwt from 'jsonwebtoken';

const BASE_URL = process.env.API_URL || 'http://localhost:5000';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function generateTestToken(): string {
  return jwt.sign(
    { 
      userId: 'test-user-123',
      email: 'test@example.com',
      role: 'admin'
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function testEndpoint(name: string, url: string, token: string) {
  console.log(`\n📋 Testing: ${name}`);
  console.log(`   URL: ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (response.ok && data.success) {
      console.log(`   ✅ Status: ${response.status}`);
      console.log(`   📦 Response:`, JSON.stringify(data, null, 2).slice(0, 500));
      if (JSON.stringify(data).length > 500) console.log('   ... (truncated)');
    } else {
      console.log(`   ❌ Status: ${response.status}`);
      console.log(`   Error:`, data.error || data);
    }
  } catch (error) {
    console.log(`   ❌ Failed:`, error instanceof Error ? error.message : error);
  }
}

async function main() {
  console.log('🧪 Fix Template Endpoint Tests');
  console.log('================================');
  
  const token = generateTestToken();
  console.log(`\n🔑 Generated test token (expires in 1h)`);

  await testEndpoint(
    'Get OPF-085 template',
    `${BASE_URL}/api/v1/epub/fix-template/OPF-085`,
    token
  );

  await testEndpoint(
    'Get EPUB-IMG-001 template',
    `${BASE_URL}/api/v1/epub/fix-template/EPUB-IMG-001`,
    token
  );

  await testEndpoint(
    'Get unknown code with suggestion',
    `${BASE_URL}/api/v1/epub/fix-template/UNKNOWN-999?suggestion=Custom%20fix%20hint`,
    token
  );

  await testEndpoint(
    'Get all templates',
    `${BASE_URL}/api/v1/epub/fix-templates`,
    token
  );

  await testEndpoint(
    'Dev endpoint (no auth)',
    `${BASE_URL}/api/v1/epub/dev/fix-template/OPF-085`,
    ''
  );

  console.log('\n✨ Tests complete!\n');
}

main().catch(console.error);
