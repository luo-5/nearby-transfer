'use strict';
const fs = require('fs');
const path = require('path');

async function testUpload() {
  console.log('1. Authenticating as phone...');
  const res = await fetch('http://192.168.9.151:56578/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: '415847b501f88dbb' })
  });
  const data = await res.json();
  console.log('Auth OK:', data.ok, 'Token:', data.token);

  console.log('2. Uploading phone_upload_sample.txt to PC WebDAV Library...');
  const uploadContent = Buffer.from('【手机上传成功】这是真机上传到电脑 NAS 共享库的内容！时间：' + new Date().toLocaleString());
  const uploadRes = await fetch('http://192.168.9.151:56578/webdav/default-share/%E6%89%8B%E6%9C%BA%E4%B8%8A%E4%BC%A0%E6%96%87%E6%A1%A3%E6%B5%8B%E8%AF%95.txt', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${data.token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': uploadContent.length
    },
    body: uploadContent
  });
  console.log('Upload HTTP Status:', uploadRes.status);
  const uploadText = await uploadRes.text();
  console.log('Upload Result:', uploadText);

  console.log('3. Re-fetching file list...');
  const listRes = await fetch('http://192.168.9.151:56578/api/list?shareId=default-share&path=', {
    headers: { 'Authorization': `Bearer ${data.token}` }
  });
  const listData = await listRes.json();
  console.log('Updated File List Items:', listData.items.map(i => i.name));
}

testUpload().catch(console.error);
