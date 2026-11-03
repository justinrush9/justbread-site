// Local dev server: serves the static site and runs api/*.js like Vercel,
// against an in-memory Postgres seeded with sample data. For UI checks only.
//   node tests/dev/server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test';
const { freshDb } = require('../helpers/db');
const seed = require('./seed');

const ROOT = path.join(__dirname, '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.jpg': 'image/jpeg' };

(async () => {
  await freshDb();
  await seed();
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      // Mirror vercel.json: admin endpoints rewrite to /api/admin?route=<name>.
      let file = path.join(ROOT, `${url.pathname}.js`);
      const name = url.pathname.slice('/api/'.length);
      if (!fs.existsSync(file) && fs.existsSync(path.join(ROOT, 'lib/routes', `${name}.js`))) {
        file = path.join(ROOT, 'api/admin.js');
        url.searchParams.set('route', name);
      }
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('{}'); }
      let body = '';
      for await (const c of req) body += c;
      req.query = Object.fromEntries(url.searchParams);
      try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      // Local http: drop the Secure flag so the cookie sticks on http://127.0.0.1
      const set = res.setHeader.bind(res);
      res.setHeader = (k, v) => set(k, k.toLowerCase() === 'set-cookie' ? String(v).replace('; Secure', '') : v);
      try { await require(file)(req, res); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  }).listen(Number(process.argv[2] || 4321), () => console.log('dev server ready'));
})();
