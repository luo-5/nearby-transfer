'use strict';

async function test() {
  console.log('Testing /api/session on 127.0.0.1...');
  const res = await fetch('http://127.0.0.1:56578/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: '415847b501f88dbb' })
  });
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Body:', text);

  if (res.status === 200) {
    const data = JSON.parse(text);
    const token = data.token;
    console.log('\nTesting /api/list with token...');
    const listRes = await fetch('http://192.168.9.151:56578/api/list?shareId=default-share&path=', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('List Status:', listRes.status);
    const listText = await listRes.text();
    console.log('List Items:', listText);
  }
}

test().catch(console.error);
