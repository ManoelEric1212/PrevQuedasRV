#!/usr/bin/env node
/*
 * Servidor local do PrevQuedasRV (sem dependencias).
 *
 *  - Serve a pasta public/ (app + editor), com suporte a Range (video/audio).
 *  - API do editor: salva os ambientes como arquivos em public/ambientes/<id>/
 *      ambiente.json          descricao do ambiente
 *      arquivos/*             audios, fotos 360, modelos importados, miniatura
 *    e mantem public/ambientes/index.json (lido pelo app, que nao precisa do servidor).
 *
 * Uso: node tools/server.js [--port 8080] [--host 127.0.0.1]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const PORT = +opt('port', process.env.PORT || 8080);
const HOST = opt('host', '127.0.0.1');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const AMB = path.join(PUBLIC, 'ambientes');
fs.mkdirSync(AMB, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ico': 'image/x-icon'
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[\w][\w.-]{0,120}$/;

// ------------------------------------------------------------------ utilidades
function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
const fail = (res, code, msg) => send(res, code, { erro: msg });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('arquivo grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function slug(s) {
  return String(s || 'ambiente').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ambiente';
}
function newId(name) {
  let id;
  do { id = slug(name) + '-' + crypto.randomBytes(3).toString('hex'); } while (fs.existsSync(path.join(AMB, id)));
  return id;
}
function envDir(id) { return path.join(AMB, id); }
function envFile(id) { return path.join(envDir(id), 'ambiente.json'); }
function readEnv(id) { return JSON.parse(fs.readFileSync(envFile(id), 'utf8')); }

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function writeEnv(id, env) {
  fs.mkdirSync(path.join(envDir(id), 'arquivos'), { recursive: true });
  env.id = id;
  env.updatedAt = new Date().toISOString();
  writeJson(envFile(id), env);
  rebuildIndex();
  return env;
}

// index.json: lista lida pelo app (que funciona sem servidor, ex.: dentro do APK)
function rebuildIndex() {
  const list = [];
  for (const id of fs.readdirSync(AMB)) {
    if (!ID_RE.test(id) || !fs.existsSync(envFile(id))) continue;
    try {
      const e = readEnv(id);
      list.push({ id, name: e.name, type: e.type, published: !!e.published, thumb: e.thumb || null, updatedAt: e.updatedAt, order: e.order || 0 });
    } catch (err) { console.warn('ambiente invalido', id, err.message); }
  }
  list.sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'pt'));
  writeJson(path.join(AMB, 'index.json'), { version: 1, ambientes: list });
  return list;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, f.name), d = path.join(dst, f.name);
    if (f.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// troca as referencias "ambientes/<old>/" por "ambientes/<new>/" dentro do JSON
function rebase(env, oldId, newIdV) {
  return JSON.parse(JSON.stringify(env).split('ambientes/' + oldId + '/').join('ambientes/' + newIdV + '/'));
}

// ------------------------------------------------------------------ API
async function api(req, res, parts) {
  const m = req.method;
  // /api/ambientes
  if (parts[0] === 'ambientes') {
    const id = parts[1];
    if (!id) {
      if (m === 'GET') return send(res, 200, rebuildIndex());
      if (m === 'POST') { // cria
        const env = JSON.parse((await readBody(req, 50e6)).toString('utf8') || '{}');
        const nid = newId(env.name);
        return send(res, 201, writeEnv(nid, env));
      }
      return fail(res, 405, 'metodo');
    }
    if (!ID_RE.test(id)) return fail(res, 400, 'id invalido');
    const exists = fs.existsSync(envFile(id));

    if (parts.length === 2) {
      if (m === 'GET') return exists ? send(res, 200, readEnv(id)) : fail(res, 404, 'nao encontrado');
      if (m === 'PUT') {
        const env = JSON.parse((await readBody(req, 50e6)).toString('utf8'));
        return send(res, 200, writeEnv(id, env));
      }
      if (m === 'DELETE') {
        if (exists) fs.rmSync(envDir(id), { recursive: true, force: true });
        rebuildIndex();
        return send(res, 200, { ok: true });
      }
      return fail(res, 405, 'metodo');
    }
    if (!exists) return fail(res, 404, 'nao encontrado');

    if (parts[2] === 'duplicar' && m === 'POST') {
      const env = readEnv(id);
      const nid = newId(env.name);
      copyDir(envDir(id), envDir(nid));
      const copy = rebase(env, id, nid);
      copy.name = (env.name || 'Ambiente') + ' (cópia)';
      copy.published = false;
      return send(res, 201, writeEnv(nid, copy));
    }
    if (parts[2] === 'pacote' && m === 'GET') { // exporta tudo num unico arquivo
      const dir = path.join(envDir(id), 'arquivos');
      const files = {};
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) files[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
      const pkg = { formato: 'prevquedas-ambiente', versao: 1, id, ambiente: readEnv(id), arquivos: files };
      res.setHeader('Content-Disposition', 'attachment; filename="' + id + '.prevamb.json"');
      return send(res, 200, pkg);
    }
    if (parts[2] === 'arquivos') {
      const name = parts[3];
      if (!name || !FILE_RE.test(name)) return fail(res, 400, 'nome de arquivo invalido');
      const file = path.join(envDir(id), 'arquivos', name);
      if (m === 'PUT') {
        const buf = await readBody(req, 200e6);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        return send(res, 200, { path: 'ambientes/' + id + '/arquivos/' + name, size: buf.length });
      }
      if (m === 'DELETE') { fs.rmSync(file, { force: true }); return send(res, 200, { ok: true }); }
    }
    return fail(res, 404, 'rota');
  }

  // /api/importar  (pacote .prevamb.json)
  if (parts[0] === 'importar' && m === 'POST') {
    const pkg = JSON.parse((await readBody(req, 500e6)).toString('utf8'));
    if (pkg.formato !== 'prevquedas-ambiente' || !pkg.ambiente) return fail(res, 400, 'arquivo nao e um pacote de ambiente');
    const nid = newId(pkg.ambiente.name);
    const dir = path.join(envDir(nid), 'arquivos');
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, b64] of Object.entries(pkg.arquivos || {})) {
      if (FILE_RE.test(f)) fs.writeFileSync(path.join(dir, f), Buffer.from(b64, 'base64'));
    }
    const env = pkg.id ? rebase(pkg.ambiente, pkg.id, nid) : pkg.ambiente;
    env.published = false;
    return send(res, 201, writeEnv(nid, env));
  }

  return fail(res, 404, 'rota');
}

// ------------------------------------------------------------------ arquivos estaticos
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'proibido');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Nao encontrado', 'text/plain; charset=utf-8');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? +range[1] : st.size - +range[2];
      let end = range[1] && range[2] ? +range[2] : st.size - 1;
      if (!range[1]) end = st.size - 1;
      if (start >= st.size || start < 0 || end < start) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const parts = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      return await api(req, res, parts);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'metodo');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    fail(res, 500, e.message);
  }
});

rebuildIndex();
server.listen(PORT, HOST, () => {
  console.log(`PrevQuedasRV em http://localhost:${PORT}`);
  console.log(`  app:    http://localhost:${PORT}/`);
  console.log(`  editor: http://localhost:${PORT}/editor.html`);
});
