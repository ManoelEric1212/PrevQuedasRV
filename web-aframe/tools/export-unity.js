#!/usr/bin/env node
/*
 * Exporta as cenas do projeto Unity PrevQuedasRV para o app A-Frame.
 *
 * Uso:  node tools/export-unity.js <pasta-do-projeto-unity>
 *
 * Gera em public/:
 *   data/scenes.js        -> window.PREV_DATA (cenas, materiais, interacoes)
 *   assets/models/*.glb   -> FBX convertidos (FBX2glTF)
 *   assets/audio/*.mp3    -> WAV convertidos (ffmpeg, se disponivel; senao copia o .wav)
 *   assets/textures/*     -> texturas usadas pelos materiais
 *   assets/ui/*, assets/video/*
 *   vendor/aframe.min.js
 *
 * Conversao de coordenadas: Unity e mao-esquerda (Y para cima), three.js/glTF e mao-direita.
 * Cada transform local do Unity e conjugado por um espelho em X:
 *   posicao (x,y,z) -> (-x,y,z)    rotacao (x,y,z,w) -> (x,-y,-z,w)    escala igual
 * e a geometria do glTF (que vem do FBX sem o espelho que o Unity aplica) entra crua.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const UNITY = path.resolve(process.argv[2] || '..');
const OUT = path.resolve(__dirname, '..', 'public');
const ASSETS = path.join(UNITY, 'Assets');

// Cenas 3D exportadas automaticamente (0 e 1 sao interface, montadas a mao no app).
const ROOM_SCENES = ['2-Quarto', '3-Quarto-risco', '4-Banheiro', '5-Banheiro-risco'];
const SCENE_TITLES = {
  '2-Quarto': 'Quarto adaptado', '3-Quarto-risco': 'Quarto com riscos',
  '4-Banheiro': 'Banheiro adaptado', '5-Banheiro-risco': 'Banheiro com riscos'
};
const EVENT_TRIGGER_SCRIPT = 'f70555f144d8491a825f0804e09c671c';

// ---------------------------------------------------------------- utilidades
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();
const r4 = (n) => Math.round(n * 10000) / 10000;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// Decodifica strings YAML do Unity ("cadeira-bra\xE7o")
function yamlStr(v) {
  if (v == null) return v;
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  } else if (v.startsWith("'") && v.endsWith("'")) {
    v = v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

const field = (body, key) => { const m = body.match(new RegExp('^\\s*' + key + ': (.*)$', 'm')); return m ? m[1] : undefined; };
const num = (body, key, def = 0) => { const v = field(body, key); return v === undefined ? def : parseFloat(v); };
function obj(str) { // "{x: 1, y: 2}" -> {x:1,y:2}
  const o = {};
  if (!str) return o;
  for (const m of str.matchAll(/(\w+): ([^,}]+)/g)) {
    const v = m[2].trim();
    o[m[1]] = /^-?[\d.]+(e[-+]?\d+)?$/i.test(v) ? parseFloat(v) : v;
  }
  return o;
}
const ref = (body, key) => obj(field(body, key));

// Divide um arquivo YAML do Unity em documentos {id: {type, stripped, body}}
function parseUnityYaml(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const docs = new Map();
  const re = /^--- !u!(\d+) &(-?\d+)( stripped)?[^\n]*\n/gm;
  let m, last = null;
  while ((m = re.exec(txt))) {
    if (last) last.body = txt.slice(last.start, m.index);
    last = { id: m[2], type: +m[1], stripped: !!m[3], start: re.lastIndex };
    docs.set(m[2], last);
  }
  if (last) last.body = txt.slice(last.start);
  return docs;
}

// ---------------------------------------------------------------- indice de assets
console.log('Indexando assets do Unity em', ASSETS);
const guidToPath = new Map();
const recycleNames = new Map(); // guid -> Map(fileID -> nome)
for (const meta of walk(ASSETS).filter((f) => f.endsWith('.meta'))) {
  const txt = fs.readFileSync(meta, 'utf8');
  const g = txt.match(/^guid: (\w+)/m);
  if (!g) continue;
  guidToPath.set(g[1], meta.slice(0, -5));
  const rn = txt.match(/fileIDToRecycleName:\n((?:    .*\n)+)/);
  if (rn) {
    const map = new Map();
    for (const l of rn[1].matchAll(/^    (\d+): (.*)$/gm)) map.set(l[1], yamlStr(l[2]));
    recycleNames.set(g[1], map);
  }
}

// ---------------------------------------------------------------- saidas
mkdirp(path.join(OUT, 'data'));
for (const d of ['models', 'audio', 'textures', 'ui', 'video']) mkdirp(path.join(OUT, 'assets', d));
mkdirp(path.join(OUT, 'vendor'));

// FBX -> GLB
const FBX2GLTF = (() => {
  const bin = { win32: 'Windows_NT/FBX2glTF.exe', darwin: 'Darwin/FBX2glTF', linux: 'Linux/FBX2glTF' }[process.platform];
  return path.join(__dirname, '..', 'node_modules', 'fbx2gltf', 'bin', bin);
})();
const models = new Map(); // guid -> {name, file, json}
function readGlbJson(file) {
  const b = fs.readFileSync(file);
  return JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}
function model(guid) {
  if (models.has(guid)) return models.get(guid);
  const src = guidToPath.get(guid);
  if (!src || !/\.fbx$/i.test(src)) return null;
  const name = slug(path.basename(src, path.extname(src)));
  const dest = path.join(OUT, 'assets', 'models', name + '.glb');
  if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) {
    console.log('  FBX -> GLB', path.basename(src));
    execFileSync(FBX2GLTF, ['--binary', '--input', src, '--output', dest.slice(0, -4)], { stdio: 'ignore' });
  }
  const json = readGlbJson(dest);
  const m = { name, file: 'assets/models/' + name + '.glb', json, recycle: recycleNames.get(guid) || new Map() };
  models.set(guid, m);
  return m;
}

// Audio
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const audios = new Map();
function audio(guid) {
  if (audios.has(guid)) return audios.get(guid);
  const src = guidToPath.get(guid);
  if (!src) return null;
  const rel = path.relative(path.join(ASSETS, 'audio'), src).split(path.sep).join('-');
  let name = slug(rel.replace(/\.[^.]+$/, ''));
  let file;
  if (HAS_FFMPEG) {
    file = 'assets/audio/' + name + '.mp3';
    const dest = path.join(OUT, file);
    if (!fs.existsSync(dest)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-b:a', '96k', dest]);
  } else {
    file = 'assets/audio/' + name + path.extname(src).toLowerCase();
    fs.copyFileSync(src, path.join(OUT, file));
  }
  audios.set(guid, file);
  return file;
}

function copyAsset(src, sub) {
  const file = `assets/${sub}/${slug(path.basename(src))}`;
  fs.copyFileSync(src, path.join(OUT, file));
  return file;
}

// Materiais (.mat do Unity -> parametros de MeshStandardMaterial)
const materials = {}; // id -> def
function material(guid) {
  if (!guid) return null;
  const src = guidToPath.get(guid);
  if (!src || !src.endsWith('.mat')) return null;
  const id = slug(path.basename(src, '.mat'));
  if (materials[id]) return id;
  const body = fs.readFileSync(src, 'utf8');
  const color = obj((body.match(/- _Color: (\{[^}]*\})/) || [])[1]);
  const def = {
    color: [color.r ?? 1, color.g ?? 1, color.b ?? 1].map(r4),
    opacity: r4(color.a ?? 1),
    metalness: r4(parseFloat((body.match(/- _Metallic: ([\d.]+)/) || [0, 0])[1])),
    roughness: r4(1 - parseFloat((body.match(/- _Glossiness: ([\d.]+)/) || [0, 0.5])[1]))
  };
  const mode = parseFloat((body.match(/- _Mode: ([\d.]+)/) || [0, 0])[1]);
  if (mode >= 2 || def.opacity < 1) def.transparent = true;
  const tex = body.match(/- _MainTex:\s+m_Texture: (\{[^}]*\})\s+m_Scale: (\{[^}]*\})\s+m_Offset: (\{[^}]*\})/);
  if (tex) {
    const t = obj(tex[1]);
    if (t.guid && guidToPath.get(t.guid)) {
      def.map = copyAsset(guidToPath.get(t.guid), 'textures');
      const s = obj(tex[2]), o = obj(tex[3]);
      if (s.x !== 1 || s.y !== 1) def.repeat = [s.x, s.y];
      if (o.x || o.y) def.offset = [o.x, o.y];
    }
  }
  const em = obj((body.match(/- _EmissionColor: (\{[^}]*\})/) || [])[1]);
  if (/_EMISSION/.test(body) && (em.r || em.g || em.b)) def.emissive = [em.r, em.g, em.b].map(r4);
  materials[id] = def;
  return id;
}

// ---------------------------------------------------------------- transforms
const conjPos = (p) => [r4(-(p.x || 0)), r4(p.y || 0), r4(p.z || 0)];
const conjRot = (q) => [r4(q.x || 0), r4(-(q.y || 0)), r4(-(q.z || 0)), r4(q.w ?? 1)];
const vec3 = (v) => [r4(v.x ?? 1), r4(v.y ?? 1), r4(v.z ?? 1)];
// glTF (mao-direita) -> valores no espaco Unity, para aplicar modificacoes parciais
const gltfToUnity = (n) => ({
  pos: { x: -(n.translation?.[0] || 0), y: n.translation?.[1] || 0, z: n.translation?.[2] || 0 },
  rot: { x: n.rotation?.[0] || 0, y: -(n.rotation?.[1] || 0), z: -(n.rotation?.[2] || 0), w: n.rotation?.[3] ?? 1 },
  scl: { x: n.scale?.[0] ?? 1, y: n.scale?.[1] ?? 1, z: n.scale?.[2] ?? 1 }
});

// ---------------------------------------------------------------- leitura de cena/prefab
function exportGraph(file, ctx) {
  const docs = parseUnityYaml(file);
  const compsOf = new Map(); // goId -> [doc]
  for (const d of docs.values()) {
    const go = field(d.body, 'm_GameObject');
    if (d.type !== 1 && go) {
      const id = String(obj(go).fileID);
      if (!compsOf.has(id)) compsOf.set(id, []);
      compsOf.get(id).push(d);
    }
  }
  const prefabInstances = [...docs.values()].filter((d) => d.type === 1001);
  // objeto "stripped" -> instancia de prefab a que pertence
  const strippedOwner = new Map();
  for (const d of docs.values()) if (d.stripped) strippedOwner.set(d.id, String(ref(d.body, 'm_PrefabInternal').fileID || ref(d.body, 'm_PrefabInstance').fileID));

  const nodes = new Map(); // transformId -> node
  const children = new Map(); // parentKey -> [node]
  const addChild = (parent, node) => { const k = parent || 'root'; if (!children.has(k)) children.set(k, []); children.get(k).push(node); };

  // Resolve a chave de pai: transforms comuns usam o proprio id; "stripped" apontam para a instancia
  const parentKey = (tid) => {
    if (!tid || tid === '0') return null;
    if (strippedOwner.has(tid)) {
      const d = docs.get(tid);
      const src = ref(d.body, 'm_CorrespondingSourceObject').fileID || ref(d.body, 'm_PrefabParentObject').fileID;
      return 'pi:' + strippedOwner.get(tid) + ':' + src;
    }
    return 't:' + tid;
  };

  // Comportamentos de um GameObject (audio, gatilhos, colisores, render)
  function behaviours(comps, node) {
    for (const c of comps) {
      const b = c.body;
      if (c.type === 33) { // MeshFilter
        const mr = ref(b, 'm_Mesh');
        const m = mr.guid && model(mr.guid);
        if (m) node.mesh = { model: m.name, name: m.recycle.get(String(mr.fileID)) };
      } else if (c.type === 23) { // MeshRenderer
        if (num(b, 'm_Enabled', 1) === 0) node.hidden = true;
        const mats = [...(b.match(/m_Materials:\n((?:  - .*\n)+)/)?.[1] || '').matchAll(/guid: (\w+)/g)].map((x) => material(x[1]));
        if (mats.length) node.materials = mats;
      } else if (c.type === 65) { // BoxCollider
        node.box = { size: vec3(obj(field(b, 'm_Size'))), center: conjPos(obj(field(b, 'm_Center'))) };
      } else if (c.type === 82) { // AudioSource
        const clip = ref(b, 'm_audioClip');
        node.audio = { src: clip.guid ? audio(clip.guid) : null, autoplay: num(b, 'm_PlayOnAwake') === 1 };
        ctx.audioByComp.set(c.id, node.audio.src);
        if (node.audio.autoplay && node.audio.src && node.active !== false) ctx.autoplay.push(node.audio.src);
      } else if (c.type === 108) { // Light
        const col = obj(field(b, 'm_Color'));
        node.light = {
          type: ['spot', 'directional', 'point', 'area'][num(b, 'm_Type')] || 'point',
          color: [col.r, col.g, col.b].map(r4), intensity: num(b, 'm_Intensity', 1),
          range: num(b, 'm_Range', 10), angle: num(b, 'm_SpotAngle', 30)
        };
      } else if (c.type === 114 && b.includes(EVENT_TRIGGER_SCRIPT)) { // EventTrigger
        node.trigger = parseTrigger(b);
      }
    }
  }

  function parseTrigger(b) {
    const t = { calls: [] };
    for (const ev of b.split(/\n  - eventID: /).slice(1)) {
      const eventID = parseInt(ev);
      for (const call of ev.split(/\n        - m_Target: /).slice(1)) {
        const target = String(obj(call.split('\n')[0]).fileID);
        const method = field(call, 'm_MethodName');
        const objArg = ref(call, 'm_ObjectArgument');
        t.calls.push({ eventID, target, method, int: num(call, 'm_IntArgument'), mat: objArg.guid ? material(objArg.guid) : null });
      }
    }
    return t;
  }

  // GameObjects normais
  for (const d of docs.values()) {
    if (d.type !== 1 || d.stripped) continue;
    const comps = compsOf.get(d.id) || [];
    const tr = comps.find((c) => c.type === 4 || c.type === 224);
    if (!tr) continue;
    const node = {
      name: yamlStr(field(d.body, 'm_Name')) || '',
      active: num(d.body, 'm_IsActive', 1) !== 0,
      position: conjPos(obj(field(tr.body, 'm_LocalPosition'))),
      rotation: conjRot(obj(field(tr.body, 'm_LocalRotation'))),
      scale: vec3(obj(field(tr.body, 'm_LocalScale')))
    };
    if (tr.type === 224) node.ui = true;
    behaviours(comps, node);
    node._father = String(ref(tr.body, 'm_Father').fileID);
    nodes.set('t:' + tr.id, node);
  }

  // Instancias de prefab
  for (const pi of prefabInstances) {
    const srcGuid = ref(pi.body, 'm_SourcePrefab').guid || ref(pi.body, 'm_ParentPrefab').guid;
    const srcPath = guidToPath.get(srcGuid) || '';
    const mods = [];
    for (const m of pi.body.matchAll(/- target: (\{[^}]*\})\s+propertyPath: (.*)\n\s+value: (.*)\n\s+objectReference: (\{[^}]*\})/g)) {
      mods.push({ target: String(obj(m[1]).fileID), path: m[2].trim(), value: m[3].trim(), ref: obj(m[4]) });
    }
    const parent = String(ref(pi.body, 'm_TransformParent').fileID);
    const base = { _father: parent, _pi: pi.id };
    if (/GoogleVR[\\/]/.test(srcPath)) {
      // So interessa o GvrEditorEmulator (pai da camera); o resto do SDK e substituido no A-Frame
      const n = { name: path.basename(srcPath, '.prefab'), ...base, sdk: true };
      applyRootMods(n, mods, { pos: {}, rot: { w: 1 }, scl: { x: 1, y: 1, z: 1 } }, null);
      nodes.set('pi:' + pi.id, n);
      continue;
    }
    if (/\.fbx$/i.test(srcPath)) {
      const m = model(srcGuid);
      const n = { name: path.basename(srcPath, path.extname(srcPath)), ...base };
      const roots = m.json.scenes[0].nodes.map((i) => m.json.nodes[i]);
      const top = roots.length === 1 && roots[0].name === 'RootNode' ? (roots[0].children || []).map((i) => m.json.nodes[i]) : roots;
      // Objetos do FBX por fileID de transform (400000 + 2k), na ordem do fileIDToRecycleName
      const byName = new Map(m.json.nodes.map((x) => [x.name, x]));
      if (top.length === 1) {
        // FBX de um objeto so: o Unity colapsa a raiz no proprio objeto
        const g = top[0];
        applyRootMods(n, mods, gltfToUnity(g), '400000');
        if (g.mesh != null) n.mesh = { model: m.name, name: m.json.meshes[g.mesh].name };
        n.materials = materialMods(mods, null);
      } else {
        applyRootMods(n, mods, { pos: {}, rot: { w: 1 }, scl: { x: 1, y: 1, z: 1 } }, '400000');
        n.children = [];
        for (const [fid, nm] of m.recycle) {
          if (!/^4\d{5}$/.test(fid) || fid === '400000') continue;
          const g = byName.get(nm);
          if (!g) continue;
          const c = { name: nm };
          applyRootMods(c, mods, gltfToUnity(g), fid);
          if (g.mesh != null) c.mesh = { model: m.name, name: m.json.meshes[g.mesh].name };
          const rendererId = String(2300000 + (parseInt(fid) - 400000));
          c.materials = materialMods(mods, rendererId);
          n.children.push(c);
          nodes.set('pi:' + pi.id + ':' + fid, c);
        }
      }
      nodes.set('pi:' + pi.id, n);
      nodes.set('pi:' + pi.id + ':400000', n);
      nodes.set('pi:' + pi.id + ':100000', n);
      continue;
    }
    if (/\.prefab$/.test(srcPath)) {
      // Prefab do proprio projeto: exporta o grafo dele e aplica as modificacoes na raiz
      const sub = exportGraph(srcPath, ctx);
      const n = { name: path.basename(srcPath, '.prefab'), ...base, children: sub.roots, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
      if (sub.roots.length === 1) {
        const r = sub.roots[0];
        const u = { pos: { x: -r.position[0], y: r.position[1], z: r.position[2] }, rot: { x: r.rotation[0], y: -r.rotation[1], z: -r.rotation[2], w: r.rotation[3] }, scl: { x: r.scale[0], y: r.scale[1], z: r.scale[2] } };
        applyRootMods(r, mods, u, sub.rootTransformId);
      }
      nodes.set('pi:' + pi.id, n);
      continue;
    }
  }

  // Componentes adicionados a objetos "stripped" (ex.: gatilho num sapato importado)
  for (const [sid, owner] of strippedOwner) {
    const d = docs.get(sid);
    if (d.type !== 1) continue;
    const src = ref(d.body, 'm_CorrespondingSourceObject').fileID || ref(d.body, 'm_PrefabParentObject').fileID;
    const tfid = String(400000 + (parseInt(src) - 100000));
    const target = nodes.get('pi:' + owner + ':' + tfid) || nodes.get('pi:' + owner);
    if (target) behaviours(compsOf.get(sid) || [], target);
  }

  // Hierarquia
  let rootTransformId = null;
  for (const [key, node] of nodes) {
    if (key.split(':').length > 2) continue; // filhos de FBX ja estao em node.children
    let pk = parentKey(node._father);
    if (pk && !nodes.has(pk) && pk.startsWith('pi:')) pk = pk.split(':').slice(0, 2).join(':');
    if (pk && nodes.has(pk)) {
      const p = nodes.get(pk);
      (p.children = p.children || []).push(node);
    } else {
      addChild(null, node);
      if (key.startsWith('t:')) rootTransformId = key.slice(2);
    }
  }
  for (const n of nodes.values()) { delete n._father; }
  return { roots: children.get('root') || [], rootTransformId, nodes };
}

function applyRootMods(n, mods, unityDefault, targetFileID) {
  const u = { pos: { ...unityDefault.pos }, rot: { ...unityDefault.rot }, scl: { ...unityDefault.scl } };
  for (const m of mods) {
    if (targetFileID && m.target !== targetFileID) continue;
    const mm = m.path.match(/^m_Local(Position|Rotation|Scale)\.([xyzw])$/);
    if (!mm) { if (m.path === 'm_IsActive' && m.value === '0') n.active = false; continue; }
    const k = { Position: 'pos', Rotation: 'rot', Scale: 'scl' }[mm[1]];
    u[k][mm[2]] = parseFloat(m.value);
  }
  n.position = conjPos(u.pos);
  n.rotation = conjRot(u.rot);
  n.scale = vec3(u.scl);
}

function materialMods(mods, rendererId) {
  const out = [];
  for (const m of mods) {
    const mm = m.path.match(/^m_Materials\.Array\.data\[(\d+)\]$/);
    if (mm && (!rendererId || m.target === rendererId) && m.ref.guid) out[+mm[1]] = material(m.ref.guid);
  }
  return out.length ? out : undefined;
}

// Liga os gatilhos (EventTrigger) aos audios/acoes e simplifica a arvore
function resolveTriggers(node, ctx) {
  if (node.trigger) {
    const it = {};
    for (const c of node.trigger.calls) {
      if (c.eventID === 4 && c.method === 'Play') it.audio = ctx.audioByComp.get(c.target) || it.audio;
      if (c.eventID === 4 && c.method === 'AbrirCena') it.scene = c.int;
      if (c.eventID === 0 && c.method === 'set_material' && c.mat) it.hover = c.mat;
    }
    if (it.audio || it.scene != null) node.interactive = it;
    delete node.trigger;
  }
  if (node.audio && !node.audio.autoplay) delete node.audio; // tocados via gatilho
  else if (node.audio) delete node.audio; // autoplay ja registrado em ctx.autoplay
  (node.children || []).forEach((c) => resolveTriggers(c, ctx));
  if (node.children && !node.children.length) delete node.children;
}

function findCamera(roots) {
  // A camera do Unity fica dentro do GvrEditorEmulator; procura o caminho ate "Main Camera"
  let found = null;
  (function rec(list, chain) {
    for (const n of list) {
      const c = chain.concat(n);
      if (n.name === 'Main Camera') found = c;
      if (n.children) rec(n.children, c);
    }
  })(roots, []);
  return found;
}

function prune(list) {
  // remove nos sem nada para mostrar (Canvas, EventSystem, nos do SDK, inativos)
  return list.filter((n) => {
    if (n.active === false) return false;
    if (n.children) n.children = prune(n.children);
    if (n.children && !n.children.length) delete n.children;
    const useful = n.mesh || n.light || n.interactive || n.box || n.children;
    if (n.ui || n.sdk || n.name === 'Main Camera') return false;
    return useful;
  }).map((n) => { delete n._pi; delete n.active; delete n.ui; if (!n.materials || !n.materials.some(Boolean)) delete n.materials; return n; });
}

// ---------------------------------------------------------------- execucao
const DATA = { version: 1, generatedAt: new Date().toISOString(), scenes: {}, materials };

for (const name of ROOM_SCENES) {
  const file = path.join(ASSETS, 'scenes', name + '.unity');
  console.log('Cena', name);
  const ctx = { audioByComp: new Map(), autoplay: [] };
  const g = exportGraph(file, ctx);
  g.roots.forEach((n) => resolveTriggers(n, ctx));
  const camChain = findCamera(g.roots);
  const camera = camChain ? camChain.map((n) => ({ position: n.position, rotation: n.rotation })) : [];

  const docs = parseUnityYaml(file);
  const rs = [...docs.values()].find((d) => d.type === 104);
  const amb = obj(field(rs.body, 'm_AmbientSkyColor'));
  const eq = obj(field(rs.body, 'm_AmbientEquatorColor'));
  const gr = obj(field(rs.body, 'm_AmbientGroundColor'));

  const roots = prune(g.roots);
  let interactiveCount = 0;
  (function count(l) { for (const n of l) { if (n.interactive) interactiveCount++; if (n.children) count(n.children); } })(roots);
  DATA.scenes[name] = {
    title: SCENE_TITLES[name],
    camera,
    ambient: { sky: [amb.r, amb.g, amb.b].map(r4), equator: [eq.r, eq.g, eq.b].map(r4), ground: [gr.r, gr.g, gr.b].map(r4) },
    autoplay: ctx.autoplay,
    nodes: roots
  };
  console.log(`  ${interactiveCount} objetos interativos, autoplay: ${ctx.autoplay.join(', ') || '-'}`);
}

// Interface (tela inicial e tutorial)
DATA.ui = {
  menuAudio: (() => { const p = path.join(ASSETS, 'audio', 'escolha-cena.wav'); const g = [...guidToPath].find(([, v]) => v === p); return g ? audio(g[0]) : null; })(),
  images: {}
};
for (const f of fs.readdirSync(path.join(ASSETS, 'interface')).filter((f) => f.endsWith('.png'))) {
  DATA.ui.images[path.basename(f, '.png')] = copyAsset(path.join(ASSETS, 'interface', f), 'ui');
}
DATA.ui.video = copyAsset(path.join(ASSETS, 'video', 'tutorial-RV.mp4'), 'video');

fs.writeFileSync(path.join(OUT, 'data', 'scenes.js'),
  '/* Gerado por tools/export-unity.js - nao editar a mao */\nwindow.PREV_DATA = ' + JSON.stringify(DATA, null, 1) + ';\n');
fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'aframe', 'dist', 'aframe-v1.7.1.min.js'), path.join(OUT, 'vendor', 'aframe.min.js'));
require('./vendor-addons.js');

console.log(`\nOK: ${Object.keys(DATA.scenes).length} cenas, ${models.size} modelos, ${audios.size} audios (${HAS_FFMPEG ? 'mp3' : 'wav'}), ${Object.keys(materials).length} materiais.`);
