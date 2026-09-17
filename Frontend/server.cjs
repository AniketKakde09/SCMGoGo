// Lightweight Node server (no external deps) that serves static files and provides /api/issues
const fs = require('fs');
const fsp = require('fs').promises;
const http = require('http');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3001;
const STATIC_DIR = path.join(__dirname, 'dist');
const ISSUES_FILE = path.join(__dirname, 'src', 'data', 'issues.json');

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const stream = fs.createReadStream(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    stream.pipe(res);
  });
}

async function handleApi(req, res) {
  const parsed = url.parse(req.url, true);
  if (req.method === 'GET' && parsed.pathname === '/api/issues') {
    try {
      const txt = await fsp.readFile(ISSUES_FILE, 'utf8');
      const data = JSON.parse(txt);
      sendJSON(res, 200, data);
    } catch (err) {
      console.error('Failed to read issues.json', err);
      sendJSON(res, 500, { error: 'Unable to read issues.json' });
    }
    return;
  }

  if (req.method === 'PUT' && parsed.pathname === '/api/issues') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const parsedBody = JSON.parse(body);
        if (!Array.isArray(parsedBody)) {
          sendJSON(res, 400, { error: 'Request body must be a JSON array.' });
          return;
        }
        // Basic validation
        const invalid = parsedBody.find((issue) => !issue || typeof issue !== 'object' || typeof issue.issue_type !== 'string' || typeof issue.summary !== 'string');
        if (invalid) {
          sendJSON(res, 400, { error: 'Invalid issue format.' });
          return;
        }
        const out = JSON.stringify(parsedBody, null, 2) + '\n';
        await fsp.writeFile(ISSUES_FILE, out, 'utf8');
        sendJSON(res, 200, { success: true, count: parsedBody.length, file: ISSUES_FILE });
      } catch (err) {
        console.error('Failed to write issues.json', err);
        sendJSON(res, 500, { error: 'Unable to write issues.json.' });
      }
    });
    return;
  }

  // Not an API route
  sendJSON(res, 404, { error: 'Not found' });
}

function handleStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.join(STATIC_DIR, decodeURIComponent(pathname));
  // Protect path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  // If path is directory, serve index.html
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      sendFile(res, path.join(filePath, 'index.html'));
    } else {
      sendFile(res, filePath);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  // Serve static or fallback to index.html for client-side routing
  const p = path.join(STATIC_DIR, req.url === '/' ? '/index.html' : req.url);
  // Serve file if exists, otherwise serve index.html
  fs.stat(path.join(STATIC_DIR, req.url === '/' ? '/index.html' : req.url), (err, stats) => {
    if (!err && stats.isFile()) {
      handleStatic(req, res);
    } else {
      // fallback to index.html
      sendFile(res, path.join(STATIC_DIR, 'index.html'));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Serving static from ${STATIC_DIR}`);
  console.log(`Issues file: ${ISSUES_FILE}`);
});
