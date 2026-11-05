import { createServer } from 'node:http';

const health = JSON.stringify({
  ok: true,
  name: 'workpivot',
  version: '0.3.0',
  apiProtocol: 1,
  storage: 'postgresql',
});

createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(health);
    return;
  }
  if (request.url === '/api/client-updates') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ generatedAt: new Date().toISOString(), updates: [] }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end('<!doctype html><html lang="zh-CN"><title>WorkPivot Windows smoke</title><body>WorkPivot</body></html>');
}).listen(39800, '127.0.0.1', () => console.log('WINDOWS_SMOKE_FIXTURE_READY'));
