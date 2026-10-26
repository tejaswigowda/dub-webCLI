#!/usr/bin/env node
// Static file server for docs/. Usage: node server.js [port]
// No COOP/COEP headers on purpose: without cross-origin isolation ONNX Runtime stays
// single-threaded, which is what keeps wasm output deterministic.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const PORT = parseInt(process.argv[2] || '5500', 10);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

http
  .createServer((req, res) => {
    if (process.env.DUB_LOG) console.log(req.method, req.url);
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) return void res.writeHead(403).end('403');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return void res.writeHead(404).end('404');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Serving docs/ at http://127.0.0.1:${PORT}`));
