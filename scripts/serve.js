#!/usr/bin/env node
'use strict';

/**
 * A dependency-free static file server for the `src/` directory.
 *
 * The pages have to be served over HTTP rather than opened from the file
 * system: browsers give `file://` pages a null origin, which blocks the
 * XMLHttpRequest calls web3 makes to the Ganache JSON-RPC endpoint.
 *
 * Usage:  npm run serve  [-- --port 8080]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.join(__dirname, '..', 'src');
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort !== -1 ? process.argv[argPort + 1] : process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
};

const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(url.parse(req.url).pathname);
  const relative = requested === '/' ? '/index.html' : requested;

  // Resolve inside ROOT only — no path traversal out of src/.
  const filePath = path.join(ROOT, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        `<h1>404</h1><p>Not found: ${requested}</p><p><a href="/index.html">Bank portal</a> · <a href="/indexCustomer.html">Customer portal</a></p>`
      );
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n  KYC DApp front end\n`);
  console.log(`    Bank portal      http://localhost:${PORT}/index.html`);
  console.log(`    Customer portal  http://localhost:${PORT}/indexCustomer.html\n`);
  console.log(`  Serving ${ROOT}`);
  console.log(`  Make sure Ganache is running on http://127.0.0.1:8545 (npm run chain)\n`);
});
