const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI0ZGRlY2I0My01YzM3LTQ2YmEtYjU5MS1iZmI5Njk3MTNhNjgiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJ0ZW5hbnRJZCI6ImVjYzRmODk2LTYxZTktNGM4ZC05ZWNhLTllYTM3ZjE5NmNjNCIsInJvbGUiOiJVU0VSIiwiaWF0IjoxNzcxNjU1MzY0LCJleHAiOjE3NzE2NTYyNjR9.92_kgJvw4HIgGGgfW45jE5EkR1sLvmWLHacR4YjIlHA';

async function upload() {
  const form = new FormData();
  form.append('file', fs.createReadStream('C:\\Users\\avrve\\Downloads\\NinjaDemo_OceanEcosystems.epub'), {
    filename: 'NinjaDemo_OceanEcosystems.epub',
    contentType: 'application/epub+zip',
  });

  try {
    console.log('📤 Uploading EPUB file...');
    const response = await axios.post('http://localhost:5000/api/v1/epub/audit-upload', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${TOKEN}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log('✅ Upload successful!');
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data.data?.fileId) {
      console.log('\n📋 File ID:', response.data.data.fileId);
      console.log('\n👀 NOW WATCH YOUR BACKEND SERVER LOGS FOR WORKFLOW PROCESSING!');
    }
  } catch (error) {
    console.error('❌ Upload failed:');
    console.error(error.response?.data || error.message);
  }
}

upload();
