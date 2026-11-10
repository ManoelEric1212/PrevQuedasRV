#!/usr/bin/env node
/*
 * Copia OrbitControls e TransformControls do three.js (o mesmo usado pelo A-Frame)
 * para public/vendor/three-addons/ e gera um "three.js" que reexporta o THREE global
 * do A-Frame, para os modulos ES funcionarem sem bundler (import map no editor.html).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'controls');
const OUT = path.join(ROOT, 'public', 'vendor', 'three-addons');
fs.mkdirSync(OUT, { recursive: true });

const names = new Set();
for (const f of ['OrbitControls.js', 'TransformControls.js']) {
  const txt = fs.readFileSync(path.join(SRC, f), 'utf8');
  const m = txt.match(/import\s*\{([^}]*)\}\s*from\s*'three'/);
  if (m) m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
  fs.writeFileSync(path.join(OUT, f), txt);
}
const shim = '/* Gerado por tools/vendor-addons.js: reexporta o THREE do A-Frame */\n' +
  'const T = window.THREE;\nexport default T;\n' +
  [...names].sort().map((n) => `export const ${n} = T.${n};`).join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'three.js'), shim);
console.log('three-addons: ' + [...names].length + ' simbolos reexportados');
