/*
 * Editor de ambientes do PrevQuedasRV (roda no PC, servido por tools/server.js).
 * Os ambientes sao salvos como arquivos em public/ambientes/<id>/ e lidos pelo app.
 */
import { OrbitControls } from '../vendor/three-addons/OrbitControls.js';
import { TransformControls } from '../vendor/three-addons/TransformControls.js';

const E = window.PrevEngine;
const THREE = window.THREE;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const r4 = (v) => Math.round(v * 10000) / 10000;
const deg = THREE.MathUtils.radToDeg, rad = THREE.MathUtils.degToRad;

// ====================================================================== API local
async function req(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (raw) { opt.body = body; } else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.erro || ('HTTP ' + r.status));
  return data;
}
const api = {
  list: () => req('GET', '/api/ambientes'),
  get: (id) => req('GET', '/api/ambientes/' + id),
  create: (env) => req('POST', '/api/ambientes', env),
  save: (id, env) => req('PUT', '/api/ambientes/' + id, env),
  remove: (id) => req('DELETE', '/api/ambientes/' + id),
  duplicate: (id) => req('POST', '/api/ambientes/' + id + '/duplicar'),
  upload: (id, name, blob) => req('PUT', '/api/ambientes/' + id + '/arquivos/' + encodeURIComponent(name), blob, true),
  importPkg: (text) => req('POST', '/api/importar', text, true)
};

// ====================================================================== utilidades de interface
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2500);
}
function extFrom(file) {
  const n = (file.name || '').toLowerCase().match(/\.(\w+)$/);
  if (n) return n[1];
  const t = file.type || '';
  if (t.includes('webm')) return 'webm';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('mpeg')) return 'mp3';
  if (t.includes('mp4')) return 'm4a';
  if (t.includes('wav')) return 'wav';
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg')) return 'jpg';
  return 'bin';
}

// ====================================================================== estado
let env = null, envId = null, envIndex = [];
let ctx = null, selectedId = null;
let undo = [], redo = [];
let saveTimer = null, saving = false, savePending = false;
let placing = false, fpMode = false;
let buildToken = 0;
const collapsed = new Set();

// ====================================================================== cena 3D
const sceneEl = $('a-scene');
await new Promise((r) => (sceneEl.hasLoaded ? r() : sceneEl.addEventListener('loaded', r)));
const world = $('#world');
const camera = $('#edcam').getObject3D('camera');
const canvas = sceneEl.canvas;
camera.position.set(6, 6, 6);

const orbit = new OrbitControls(camera, canvas);
orbit.screenSpacePanning = true;
orbit.maxPolarAngle = Math.PI * 0.495;

const transform = new TransformControls(camera, canvas);
transform.setSize(0.9);
sceneEl.object3D.add(transform.getHelper());
let dragSnap = null;
transform.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value && !isLookMode();
  if (e.value) dragSnap = JSON.stringify(env);
  else {
    if (dragSnap && dragSnap !== JSON.stringify(env)) pushUndo(dragSnap);
    dragSnap = null;
    renderProps();
    scheduleSave();
  }
});
transform.addEventListener('objectChange', onGizmoChange);

const helpers = new THREE.Group();
helpers.name = 'editor-helpers';
sceneEl.object3D.add(helpers);
const selBox = new THREE.BoxHelper(undefined, 0xffc400);
selBox.visible = false;
helpers.add(selBox);
let kindBoxes = [];

// marcador do visitante (ponto inicial): pessoa + seta para onde olha (+Z)
const spawnObj = new THREE.Group();
spawnObj.name = 'spawn';
{
  const mat = new THREE.MeshBasicMaterial({ color: 0x1e88e5, depthTest: false, transparent: true, opacity: 0.9 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.6, 20), mat);
  body.position.y = -0.8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 10), mat);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 16), mat);
  arrow.rotation.x = Math.PI / 2; arrow.position.set(0, 0, 0.4);
  [body, head, arrow].forEach((m) => { m.renderOrder = 5; m.userData.spawn = true; spawnObj.add(m); });
}
sceneEl.object3D.add(spawnObj);

AFRAME.registerComponent('editor-tick', {
  tick() {
    if (selBox.visible && selBox.userData.target) selBox.setFromObject(selBox.userData.target);
    kindBoxes.forEach((b) => b.setFromObject(b.userData.target));
  }
});
sceneEl.setAttribute('editor-tick', '');

// ---------------------------------------------------------------- modo "olhar" (foto 360 e visitante)
const look = { yaw: 0, pitch: 0 };
function isLookMode() { return (env && env.type === 'photo') || fpMode; }
function applyLook() { camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ'); }
// yaw do ambiente (direcao +Z do visitante) -> yaw da camera (que olha para -Z)
function setLookFromEnvYaw(yawDeg) { look.yaw = rad(yawDeg) + Math.PI; look.pitch = 0; applyLook(); }
function envYawFromCamera() {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return r4(deg(Math.atan2(d.x, d.z)));
}

// ---------------------------------------------------------------- selecao com o mouse
const raycaster = new THREE.Raycaster();
raycaster.camera = camera;
function ndc(ev) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
}
function nodeIdOf(o) {
  while (o) {
    if (o.el && o.el.dataset) {
      if (o.el.dataset.hitFor) return o.el.dataset.hitFor;
      if (o.el.dataset.nodeId) return o.el.dataset.nodeId;
    }
    o = o.parent;
  }
  return null;
}
function pick(ev) {
  raycaster.setFromCamera(ndc(ev), camera);
  if (spawnObj.visible && raycaster.intersectObject(spawnObj, true).length) return '__spawn';
  for (const hit of raycaster.intersectObject(world.object3D, true)) {
    const id = nodeIdOf(hit.object);
    if (id) return groupTarget(id);
  }
  return null;
}
// clique numa peca de um conjunto (cama completa...) seleciona o conjunto; clicar de novo seleciona a peca
function ancestorsOf(id) {
  const chain = [];
  let f = env.type === 'model' ? E.findNode(env.nodes, id) : null;
  while (f) { chain.unshift(f.node); f = f.parent ? E.findNode(env.nodes, f.parent.id) : null; }
  return chain;
}
function groupTarget(id) {
  if (env.type !== 'model') return id;
  const chain = ancestorsOf(id);
  const top = chain.find((n) => n.group);
  if (!top) return id;
  const insideSel = chain.some((n) => n.id === selectedId);
  return insideSel ? id : top.id;
}

let down = null;
canvas.addEventListener('pointerdown', (ev) => {
  down = { x: ev.clientX, y: ev.clientY, gizmo: transform.axis !== null, button: ev.button, moved: false };
  if (!env || down.gizmo) return;
  if (isLookMode()) {
    canvas.setPointerCapture(ev.pointerId);
    if (env.type === 'photo') {
      const id = pick(ev);
      if (placing) { placeHotspot(ev); down.done = true; return; }
      if (id) { select(id); down.drag = { id, snap: JSON.stringify(env) }; return; }
    }
    down.look = { yaw: look.yaw, pitch: look.pitch };
  }
});
canvas.addEventListener('pointermove', (ev) => {
  if (!down) return;
  const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) down.moved = true;
  if (down.drag) {
    raycaster.setFromCamera(ndc(ev), camera);
    const yp = E.yawPitchFromDir(raycaster.ray.direction);
    const hs = env.hotspots.find((x) => x.id === down.drag.id);
    if (hs) {
      hs.yaw = r4(yp.yaw); hs.pitch = r4(yp.pitch);
      const el = ctx && ctx.entities[hs.id];
      if (el) el.object3D.position.copy(E.dirFromYawPitch(hs.yaw, hs.pitch).multiplyScalar(E.PHOTO_RADIUS).add(new THREE.Vector3(0, E.EYE, 0)));
    }
  } else if (down.look) {
    const k = (camera.fov / canvas.clientHeight) * (Math.PI / 180);
    look.yaw = down.look.yaw + dx * k;
    look.pitch = THREE.MathUtils.clamp(down.look.pitch + dy * k, -1.5, 1.5);
    applyLook();
  }
});
canvas.addEventListener('pointerup', (ev) => {
  const d = down; down = null;
  if (!d || !env || d.gizmo || d.done) return;
  if (d.drag) {
    if (d.moved && d.drag.snap !== JSON.stringify(env)) { pushUndo(d.drag.snap); scheduleSave(); rebuild(); }
    return;
  }
  if (d.moved || d.button !== 0) return;
  if (fpMode) return;
  select(pick(ev));
});
canvas.addEventListener('wheel', (ev) => {
  if (!isLookMode()) return;
  ev.preventDefault();
  camera.fov = THREE.MathUtils.clamp(camera.fov + ev.deltaY * 0.05, 25, 100);
  camera.updateProjectionMatrix();
}, { passive: false });

// ====================================================================== montagem / helpers
async function rebuild() {
  const token = ++buildToken;
  transform.detach();
  E.clearWorld(world);
  kindBoxes.forEach((b) => helpers.remove(b)); kindBoxes = [];
  sceneEl.setAttribute('background', 'color', env.background || '#9fb6bf');
  const built = await E.build(env, { world, editor: true });
  if (token !== buildToken) return ctx;
  ctx = built;
  decorate();
  setupClip();
  updateSpawn();
  attachGizmo();
  return ctx;
}

// ---------------------------------------------------------------- corte do teto (vista de maquete)
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
sceneEl.renderer.localClippingEnabled = true;
let clipOn = true, clipY = 1e6;
function setupClip() {
  clipY = 1e6;
  if (env.type === 'model') {
    // altura do teto: parte de baixo dos objetos chamados "teto" (comodos do Unity) ou altura do comodo gerado
    E.eachNode(env.nodes, (n) => {
      const el = /^teto/i.test(n.name || '') && ctx.entities[n.id];
      if (!el) return;
      const b = new THREE.Box3().setFromObject(el.object3D);
      if (!b.isEmpty()) clipY = Math.min(clipY, b.min.y - 0.05);
    });
    if (clipY === 1e6 && env.room) clipY = (env.room.height || 2.7) - 0.02;
  }
  world.object3D.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.clippingPlanes = [clipPlane]; });
  });
  $('#btn-clip').hidden = clipY === 1e6;
  applyClip();
}
function applyClip() {
  clipPlane.constant = clipOn && !fpMode && env && env.type === 'model' ? clipY : 1e6;
  $('#btn-clip').classList.toggle('on', clipOn);
}

// contornos coloridos nos objetos interativos + bolinha nas luzes
function decorate() {
  if (env.type === 'photo') return;
  E.eachNode(env.nodes, (n) => {
    const el = ctx.entities[n.id];
    if (!el) return;
    if (n.light) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd54f }));
      el.setObject3D('editor-light', s);
    }
    if (n.interactive && !n.hidden) {
      const it = E.normInteractive(n.interactive);
      const b = new THREE.BoxHelper(el.object3D, new THREE.Color((E.KINDS[it.kind] || E.KINDS.info).color));
      b.material.depthTest = false; b.material.transparent = true; b.material.opacity = 0.75;
      b.renderOrder = 4;
      b.userData.target = el.object3D;
      helpers.add(b); kindBoxes.push(b);
    }
  });
}

function updateSpawn() {
  spawnObj.visible = env.type === 'model' && !fpMode;
  if (env.type !== 'model') return;
  spawnObj.position.fromArray(env.camera.position);
  spawnObj.quaternion.copy(E.cameraQuaternion(env.camera));
}

function attachGizmo() {
  transform.detach();
  selBox.visible = false;
  if (!selectedId || !env) return;
  if (selectedId === '__spawn') {
    transform.attach(spawnObj);
  } else {
    const el = ctx && ctx.entities[selectedId];
    if (!el) return;
    selBox.userData.target = el.object3D; selBox.visible = true;
    if (env.type === 'model' && !fpMode) transform.attach(el.object3D);
  }
  applyToolMode();
}

let toolMode = 'translate';
function applyToolMode() {
  let m = toolMode;
  if (selectedId === '__spawn' && m === 'scale') m = 'translate';
  transform.setMode(m);
  const spawnRot = selectedId === '__spawn' && m === 'rotate';
  transform.showX = !spawnRot; transform.showZ = !spawnRot; transform.showY = true;
  $$('#tool-modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === toolMode));
}

function onGizmoChange() {
  const o = transform.object;
  if (!o) return;
  if (selectedId === '__spawn') {
    env.camera = { position: o.position.toArray().map(r4), rotation: o.quaternion.toArray().map(r4) };
  } else {
    const f = E.findNode(env.nodes, selectedId);
    if (!f) return;
    f.node.position = o.position.toArray().map(r4);
    f.node.rotation = o.quaternion.toArray().map(r4);
    f.node.scale = o.scale.toArray().map(r4);
  }
  refreshTransformFields();
}

// ====================================================================== desfazer / salvar
function pushUndo(snap) {
  undo.push(snap);
  if (undo.length > 100) undo.shift();
  redo = [];
  updateUndoButtons();
}
function mutate(fn, opts = {}) {
  const snap = JSON.stringify(env);
  fn();
  if (snap === JSON.stringify(env)) return Promise.resolve();
  pushUndo(snap);
  return afterChange(opts);
}
function afterChange({ rebuild: rb = true, props = true, tree = true } = {}) {
  scheduleSave();
  if (tree) renderTree();
  if (props) renderProps();
  return rb ? rebuild() : Promise.resolve();
}
function restore(json) {
  env = JSON.parse(json);
  if (selectedId && selectedId !== '__spawn' && !findSelected()) selectedId = null;
  $('#env-name').value = env.name || '';
  updateUndoButtons();
  afterChange();
}
function doUndo() { if (!undo.length) return; redo.push(JSON.stringify(env)); restore(undo.pop()); }
function doRedo() { if (!redo.length) return; undo.push(JSON.stringify(env)); restore(redo.pop()); }
function updateUndoButtons() { $('#btn-undo').disabled = !undo.length; $('#btn-redo').disabled = !redo.length; }

function setStatus(t) { $('#save-status').textContent = t; }
function scheduleSave() {
  setStatus('Alterado…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!env) return;
  if (saving) { savePending = true; return; }
  saving = true; setStatus('Salvando…');
  try {
    const res = await api.save(envId, env);
    env.updatedAt = res.updatedAt;
    setStatus('Salvo');
  } catch (e) { setStatus('Erro ao salvar'); toast('Erro ao salvar: ' + e.message, true); }
  saving = false;
  if (savePending) { savePending = false; await saveNow(); }
}
window.addEventListener('beforeunload', (e) => { if (saveTimer || saving) { e.preventDefault(); e.returnValue = ''; } });

// ====================================================================== miniatura
async function captureThumb() {
  if (!env || !ctx) return;
  const st = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
  const vis = { helpers: helpers.visible, gizmo: transform.getHelper().visible, spawn: spawnObj.visible };
  helpers.visible = false; transform.getHelper().visible = false; spawnObj.visible = false;
  clipPlane.constant = 1e6;
  if (env.type === 'model') {
    camera.position.fromArray(env.camera.position);
    camera.quaternion.copy(E.cameraQuaternion(env.camera)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)));
  } else {
    camera.position.set(0, E.EYE, 0);
    camera.quaternion.setFromEuler(new THREE.Euler(0, rad(E.cameraYawDeg(env.camera)) + Math.PI, 0, 'YXZ'));
  }
  camera.fov = 70; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const renderer = sceneEl.renderer;
  renderer.render(sceneEl.object3D, camera);
  const W = 480, H = 270, src = renderer.domElement;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const sw = src.width, sh = src.height, scale = Math.max(W / sw, H / sh);
  const cw = W / scale, chh = H / scale;
  c.getContext('2d').drawImage(src, (sw - cw) / 2, (sh - chh) / 2, cw, chh, 0, 0, W, H);
  camera.position.copy(st.pos); camera.quaternion.copy(st.quat); camera.fov = st.fov; camera.updateProjectionMatrix();
  helpers.visible = vis.helpers; transform.getHelper().visible = vis.gizmo; spawnObj.visible = vis.spawn;
  applyClip();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  try {
    const res = await api.upload(envId, 'miniatura.jpg', blob);
    env.thumb = res.path;
    await saveNow();
  } catch (e) { console.warn('miniatura', e); }
}

// ====================================================================== camera do editor
function worldBox() {
  const box = new THREE.Box3();
  world.object3D.updateMatrixWorld(true);
  world.object3D.traverse((o) => {
    if ((o.isMesh) && o.geometry && o.visible && !(o.userData && o.userData.isHitBox)) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  return box;
}
function frameAll(top) {
  if (env.type === 'photo') return;
  let box = worldBox();
  if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2.5, 2));
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.z, 2);
  c.y = Math.min(c.y, 1);
  orbit.target.copy(c);
  if (top) camera.position.set(c.x, c.y + r * 1.5, c.z + 0.01);
  else {
    // de cima, do lado oposto ao que o visitante olha (ve o que ele ve)
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(E.cameraQuaternion(env.camera)); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    camera.position.copy(c).addScaledVector(fwd, -r * 0.55).add(new THREE.Vector3(0, r * 0.8, 0));
  }
  orbit.update();
}
function focusSelected() {
  const el = selectedId && selectedId !== '__spawn' && ctx && ctx.entities[selectedId];
  const obj = selectedId === '__spawn' ? spawnObj : el && el.object3D;
  if (!obj || isLookMode()) return;
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length(), 0.5);
  const dir = camera.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 1.8);
  orbit.update();
}
let fpSaved = null;
function setFirstPerson(on) {
  if (env.type !== 'model' || on === fpMode) return;
  fpMode = on;
  $('#btn-fp').classList.toggle('on', on);
  if (on) {
    fpSaved = { pos: camera.position.clone(), target: orbit.target.clone() };
    orbit.enabled = false;
    camera.position.fromArray(env.camera.position);
    setLookFromEnvYaw(E.cameraYawDeg(env.camera));
    hint('Visão do visitante: arraste para olhar em volta · Esc para sair');
  } else {
    camera.position.copy(fpSaved.pos);
    orbit.target.copy(fpSaved.target);
    orbit.enabled = true;
    orbit.update();
    hint(null);
  }
  helpers.visible = !on;
  applyClip();
  updateSpawn();
  attachGizmo();
}
function hint(t) { const el = $('#vp-hint'); el.hidden = !t; el.textContent = t || ''; }

// ====================================================================== edicao
function findSelected() {
  if (!selectedId || !env) return null;
  if (env.type === 'photo') {
    const hs = (env.hotspots || []).find((x) => x.id === selectedId);
    return hs ? { node: hs, parent: null, hotspot: true } : null;
  }
  return E.findNode(env.nodes, selectedId);
}
function select(id) {
  selectedId = id || null;
  attachGizmo();
  renderTree();
  renderProps();
}
function siblingsOf(f) { return f.parent ? f.parent.children : (f.hotspot ? env.hotspots : env.nodes); }

function deleteSelected() {
  const f = findSelected();
  if (!f) return;
  mutate(() => { const arr = siblingsOf(f); arr.splice(arr.indexOf(f.node), 1); selectedId = null; });
}
function duplicateSelected() {
  const f = findSelected();
  if (!f) return;
  const copy = E.clone(f.node);
  E.eachNode([copy], (n) => { n.id = E.uid(); });
  copy.name = (copy.name || 'objeto') + ' (cópia)';
  if (f.hotspot) { copy.yaw = r4(copy.yaw + 8); } else if (copy.position) copy.position = [copy.position[0] + 0.3, copy.position[1], copy.position[2]];
  mutate(() => { const arr = siblingsOf(f); arr.splice(arr.indexOf(f.node) + 1, 0, copy); selectedId = copy.id; });
}

// apoia o objeto na superficie abaixo dele (piso, mesa...)
function dropToFloor(id, withUndo = true) {
  const f = E.findNode(env.nodes, id);
  const el = ctx && ctx.entities[id];
  if (!f || !el) return;
  const box = new THREE.Box3();
  el.object3D.updateMatrixWorld(true);
  el.object3D.traverse((o) => {
    if (o.isMesh && o.geometry && !o.userData.isHitBox) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const rc = new THREE.Raycaster(new THREE.Vector3(c.x, c.y, c.z), new THREE.Vector3(0, -1, 0));
  rc.camera = camera; // necessario para testar sprites (marcadores)
  let floorY = 0;
  const own = new Set(); el.object3D.traverse((o) => own.add(o));
  for (const hit of rc.intersectObject(world.object3D, true)) {
    const o = hit.object;
    if (own.has(o) || o.userData.isHitBox || (o.material && o.material.visible === false) || o.isSprite) continue;
    floorY = hit.point.y; break;
  }
  const dy = floorY - box.min.y;
  if (Math.abs(dy) < 1e-4) return;
  const apply = () => {
    const wp = el.object3D.getWorldPosition(new THREE.Vector3());
    wp.y += dy;
    el.object3D.parent.worldToLocal(wp);
    el.object3D.position.copy(wp);
    f.node.position = wp.toArray().map(r4);
  };
  if (withUndo) mutate(apply, { rebuild: false, tree: false }); else { apply(); scheduleSave(); renderProps(); }
}

async function addNode(item) {
  if (env.type !== 'model') return;
  const node = E.clone(item);
  E.eachNode([node], (n) => { n.id = E.uid(); });
  const t = orbit.target;
  const y = node.position ? node.position[1] : 0;
  node.position = [r4(t.x), y, r4(t.z)];
  await mutate(() => { env.nodes.push(node); selectedId = node.id; });
  if (!node.light && !(node.mesh && node.mesh.primitive === 'marker')) dropToFloor(node.id, false);
}

function placeHotspot(ev) {
  raycaster.setFromCamera(ndc(ev), camera);
  const yp = E.yawPitchFromDir(raycaster.ray.direction);
  const n = (env.hotspots || []).length + 1;
  const hs = { id: E.uid(), name: 'Ponto ' + n, label: '', yaw: r4(yp.yaw), pitch: r4(yp.pitch), size: 1.6,
    interactive: { kind: 'risco', title: '', text: '', audio: null, action: null } };
  setPlacing(false);
  mutate(() => { env.hotspots = env.hotspots || []; env.hotspots.push(hs); selectedId = hs.id; });
}
function setPlacing(on) {
  placing = on;
  $('#btn-place').classList.toggle('on', on);
  $('#btn-place').textContent = on ? 'Clique na foto…' : '+ Colocar ponto';
  canvas.style.cursor = on ? 'crosshair' : '';
  hint(on ? 'Clique no lugar da foto onde o ponto deve ficar (Esc cancela)' : null);
}

// ====================================================================== arvore (painel esquerdo)
function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  if (!env) return;
  if (env.type === 'photo') {
    (env.hotspots || []).forEach((hs) => {
      const it = E.normInteractive(hs.interactive) || {};
      tree.append(h('div', { class: 'item' + (hs.id === selectedId ? ' sel' : ''), onclick: () => select(hs.id) },
        h('span', { class: 'dot ' + (it.kind || '') }), h('span', { class: 'nm' }, hs.name || 'Ponto')));
    });
    $('#left-hint').textContent = (env.hotspots || []).length ? '' : 'Use "+ Colocar ponto" e clique na foto para marcar riscos e adaptações.';
    return;
  }
  const add = (nodes, depth) => nodes.forEach((n) => {
    const kids = n.children && n.children.length;
    const it = n.interactive && E.normInteractive(n.interactive);
    const row = h('div', { class: 'item' + (n.id === selectedId ? ' sel' : '') + (n.hidden ? ' hidden-node' : ''), style: 'padding-left:' + (8 + depth * 14) + 'px', onclick: () => select(n.id) },
      h('span', { class: 'tw', onclick: (e) => { if (!kids) return; e.stopPropagation(); collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id); renderTree(); } }, kids ? (collapsed.has(n.id) ? '▸' : '▾') : ''),
      h('span', { class: 'dot ' + (it ? it.kind : '') }),
      h('span', { class: 'nm', title: n.name }, n.name || '(sem nome)'),
      h('button', { class: 'eye', title: n.hidden ? 'Mostrar' : 'Esconder', onclick: (e) => { e.stopPropagation(); mutate(() => { n.hidden = !n.hidden; if (!n.hidden) delete n.hidden; }); } }, n.hidden ? '◌' : '●'));
    tree.append(row);
    if (kids && !collapsed.has(n.id)) add(n.children, depth + 1);
  });
  tree.append(h('div', { class: 'item' + (selectedId === '__spawn' ? ' sel' : ''), onclick: () => select('__spawn') },
    h('span', { class: 'tw' }), h('span', { class: 'dot', style: 'background:#1e88e5' }), h('span', { class: 'nm' }, 'Ponto inicial do visitante')));
  add(env.nodes || [], 0);
  $('#left-hint').textContent = 'Clique num objeto na visão 3D ou na lista. Bolinha colorida = objeto marcado (vermelho risco, verde prevenção, azul informação).';
  const sel = tree.querySelector('.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// ====================================================================== propriedades (painel direito)
function field(label, input) { return h('label', { class: 'field' }, h('span', {}, label), input); }

// campo de texto ligado a um caminho do ambiente (um passo de desfazer por edicao)
function bindText(input, get, set, onLive) {
  input.value = get() || '';
  let snap = null;
  input.addEventListener('focus', () => { snap = JSON.stringify(env); });
  input.addEventListener('input', () => { set(input.value); scheduleSave(); if (onLive) onLive(); });
  input.addEventListener('change', () => { if (snap && snap !== JSON.stringify(env)) pushUndo(snap); snap = JSON.stringify(env); });
  return input;
}

let tfFields = null;
function transformSection(node) {
  const mk = () => h('input', { type: 'number', step: '0.05' });
  const pos = [mk(), mk(), mk()], rot = [mk(), mk(), mk()], scl = [mk(), mk(), mk()];
  rot.forEach((i) => { i.step = '5'; });
  scl.forEach((i) => { i.step = '0.1'; });
  tfFields = { node, pos, rot, scl };
  refreshTransformFields();
  const commit = () => mutate(() => {
    node.position = pos.map((i) => +i.value || 0);
    const e = new THREE.Euler(rad(+rot[0].value || 0), rad(+rot[1].value || 0), rad(+rot[2].value || 0));
    node.rotation = new THREE.Quaternion().setFromEuler(e).toArray().map(r4);
    node.scale = scl.map((i) => (+i.value || 1));
    const el = ctx && ctx.entities[node.id];
    if (el) { el.object3D.position.fromArray(node.position); el.object3D.quaternion.fromArray(node.rotation); el.object3D.scale.fromArray(node.scale); }
  }, { rebuild: false, props: false, tree: false });
  [...pos, ...rot, ...scl].forEach((i) => i.addEventListener('change', commit));
  return h('div', { class: 'sec' }, h('h4', {}, 'Posição e tamanho'),
    field('Posição X · Y · Z (m)', h('div', { class: 'xyz' }, pos)),
    field('Rotação X · Y · Z (graus)', h('div', { class: 'xyz' }, rot)),
    field('Escala X · Y · Z', h('div', { class: 'xyz' }, scl)));
}
function refreshTransformFields() {
  if (!tfFields) return;
  const n = tfFields.node;
  if (selectedId === '__spawn' || !n || n.id !== selectedId) return;
  const p = n.position || [0, 0, 0], q = new THREE.Quaternion().fromArray(n.rotation || [0, 0, 0, 1]), s = n.scale || [1, 1, 1];
  const e = new THREE.Euler().setFromQuaternion(q);
  const set = (i, v, d) => { if (document.activeElement !== i) i.value = (+v).toFixed(d); };
  tfFields.pos.forEach((i, k) => set(i, p[k], 3));
  set(tfFields.rot[0], deg(e.x), 1); set(tfFields.rot[1], deg(e.y), 1); set(tfFields.rot[2], deg(e.z), 1);
  tfFields.scl.forEach((i, k) => set(i, s[k], 3));
}

// ---------------------------------------------------------------- audio (arquivo ou gravacao)
let recorder = null;
function audioBox(get, set, label) {
  const box = h('div', { class: 'audio-box' });
  const draw = () => {
    box.innerHTML = '';
    const src = get();
    if (src) box.append(h('audio', { controls: true, src, preload: 'none' }));
    else box.append(h('div', { class: 'muted small-text', style: 'margin-bottom:6px' }, 'Nenhum áudio.'));
    const file = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: async () => {
      const f = file.files[0]; if (!f) return;
      await uploadAudio(f, set);
    } });
    const recBtn = h('button', { type: 'button', onclick: () => toggleRecord(recBtn, set) }, '● Gravar');
    box.append(h('div', { class: 'row' },
      h('label', { class: 'btn-like' }, src ? 'Trocar arquivo' : 'Enviar arquivo', file),
      recBtn,
      src ? h('button', { type: 'button', class: 'danger', onclick: () => mutate(() => set(null), { rebuild: false }) }, 'Remover') : null));
  };
  draw();
  return field(label || 'Áudio', box);
}
async function uploadAudio(blob, set) {
  try {
    toast('Enviando áudio…');
    const res = await api.upload(envId, 'audio-' + E.uid() + '.' + extFrom(blob), blob);
    await mutate(() => set(res.path), { rebuild: false });
    toast('Áudio salvo');
  } catch (e) { toast('Erro ao enviar áudio: ' + e.message, true); }
}
async function toggleRecord(btn, set) {
  if (recorder) { recorder.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { toast('Não foi possível usar o microfone: ' + e.message, true); return; }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  recorder = rec;
  const t0 = Date.now();
  btn.classList.add('rec');
  const tick = setInterval(() => { btn.textContent = '■ Parar (' + Math.round((Date.now() - t0) / 1000) + ' s)'; }, 250);
  btn.textContent = '■ Parar (0 s)';
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    clearInterval(tick); recorder = null;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size) await uploadAudio(blob, set);
    else renderProps();
  };
  rec.start();
}

// ---------------------------------------------------------------- interacao (marcacao do objeto)
function interactionSection(holder, allowNone) {
  const it = holder.interactive ? E.normInteractive(holder.interactive) : null;
  if (holder.interactive && holder.interactive !== it) {
    // migra o formato antigo (Unity) sem registrar desfazer
    holder.interactive = Object.assign({}, it);
  }
  const cur = it ? it.kind : '';
  const kinds = [['', 'Nenhuma'], ['risco', 'Risco'], ['prevencao', 'Prevenção'], ['info', 'Informação']].filter((k) => allowNone || k[0]);
  const sec = h('div', { class: 'sec' }, h('h4', {}, 'Marcação'));
  sec.append(h('div', { class: 'kinds', style: allowNone ? '' : 'grid-template-columns: repeat(3, 1fr)' },
    kinds.map(([k, label]) => h('button', { type: 'button', 'data-kind': k, class: cur === k ? 'on' : '', onclick: () => mutate(() => {
      if (!k) { delete holder.interactive; return; }
      holder.interactive = Object.assign({ title: '', text: '', audio: null, action: null }, holder.interactive || {}, { kind: k });
      delete holder.interactive.hover; // passa a usar a cor do tipo
    }) }, label))));
  if (!holder.interactive) {
    sec.append(h('p', { class: 'muted small-text' }, 'Marque o objeto para que ele se destaque quando o visitante olhar e mostre um texto e/ou toque um áudio.'));
    return sec;
  }
  const I = holder.interactive;
  sec.append(field('Título (aparece na placa)', bindText(h('input', { placeholder: 'Ex.: Tapete solto' }), () => I.title, (v) => { I.title = v; })));
  sec.append(field('Texto explicativo', bindText(h('textarea', { placeholder: 'Ex.: Tapetes soltos podem fazer você tropeçar. Prefira tapetes antiderrapantes.' }), () => I.text, (v) => { I.text = v; })));
  sec.append(audioBox(() => I.audio, (v) => { I.audio = v; }, 'Áudio (narração)'));
  const sel = h('select', { onchange: () => mutate(() => { I.action = sel.value || null; }, { rebuild: false }) },
    h('option', { value: '' }, 'Mostrar o texto e tocar o áudio'),
    h('option', { value: 'menu' }, 'Voltar ao menu'),
    envIndex.filter((a) => a.id !== envId).map((a) => h('option', { value: 'amb:' + a.id }, 'Ir para: ' + a.name)));
  sel.value = I.action || '';
  sec.append(field('Ao selecionar', sel));
  return sec;
}

function introSection() {
  env.intro = env.intro || { text: '', audio: null };
  const I = env.intro;
  return h('div', { class: 'sec' }, h('h4', {}, 'Narração de abertura'),
    h('p', { class: 'muted small-text' }, 'Toca/aparece assim que o visitante entra no ambiente.'),
    field('Texto', bindText(h('textarea', { placeholder: 'Ex.: Observe o quarto e encontre os riscos de queda.' }), () => I.text, (v) => { I.text = v; })),
    audioBox(() => I.audio, (v) => { I.audio = v; }, 'Áudio'));
}

function publishSection() {
  return h('div', { class: 'sec' }, h('h4', {}, 'Publicação'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!env.published, onchange: (e) => mutate(() => { env.published = e.target.checked; }, { rebuild: false }) }),
      'Mostrar no app (menu "Outros ambientes")'),
    h('div', { class: 'danger-zone' },
      h('button', { type: 'button', onclick: () => exportPkg(envId) }, '⇩ Exportar pacote'),
      h('button', { type: 'button', class: 'danger', onclick: () => deleteEnv(envId, env.name, true) }, 'Excluir ambiente')));
}

const TEXTURES = (() => {
  const set = new Set(['lajota-madeira-gimp', 'piso-gimp', 'madeira-gimp', 'pedra-gimp', 'madeira-escura-gimp']);
  Object.values(E.DATA.materials).forEach((m) => { if (m.map) set.add(m.map.split('/').pop().replace(/\.png$/, '')); });
  return [...set].sort();
})();

function envProps(p) {
  p.append(h('h3', {}, env.type === 'photo' ? 'Ambiente (foto 360°)' : 'Ambiente'));
  if (env.type === 'photo') {
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
      const f = file.files[0]; if (!f) return;
      toast('Enviando foto…');
      try { const res = await api.upload(envId, 'foto-' + E.uid() + '.' + extFrom(f), f); await mutate(() => { env.photo = res.path; }); toast('Foto trocada'); } catch (e) { toast(e.message, true); }
    } });
    p.append(h('div', { class: 'sec' }, h('h4', {}, 'Foto'),
      h('div', { class: 'row' }, h('label', { class: 'btn-like' }, 'Trocar foto', file)),
      h('p', { class: 'muted small-text' }, 'Gire a visão até a direção que o visitante deve ver primeiro e clique abaixo.'),
      h('button', { type: 'button', onclick: () => mutate(() => { env.camera = { position: [0, E.EYE, 0], yaw: envYawFromCamera() }; }, { rebuild: false }).then(() => toast('Direção inicial definida')) }, '⌖ Usar a direção atual como inicial')));
  } else {
    if (env.room) {
      const R = env.room;
      const num = (k, min, max) => { const i = h('input', { type: 'number', step: '0.1', min, max, value: R[k] }); i.addEventListener('change', () => mutate(() => { R[k] = THREE.MathUtils.clamp(+i.value || R[k], min, max); })); return i; };
      const color = (k) => { const i = h('input', { type: 'color', value: R[k] || '#ffffff' }); i.addEventListener('change', () => mutate(() => { R[k] = i.value; })); return i; };
      const tex = h('select', { onchange: () => mutate(() => { R.floorTexture = tex.value || null; }) }, h('option', { value: '' }, '(sem textura, só cor)'), TEXTURES.map((t) => h('option', { value: t }, t.replace(/-gimp$/, '').replace(/-/g, ' '))));
      tex.value = R.floorTexture || '';
      p.append(h('div', { class: 'sec' }, h('h4', {}, 'Cômodo'),
        field('Largura · Profundidade · Altura (m)', h('div', { class: 'xyz' }, num('width', 1, 30), num('depth', 1, 30), num('height', 2, 6))),
        field('Piso', tex),
        h('div', { class: 'xyz', style: 'grid-template-columns: 1fr 1fr' }, field('Cor do piso', color('floorColor')), field('Cor das paredes', color('wallColor'))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: R.ceiling !== false, onchange: (e) => mutate(() => { R.ceiling = e.target.checked; }) }), 'Teto')));
    }
    const bg = h('input', { type: 'color', value: env.background || '#9fb6bf' });
    bg.addEventListener('change', () => mutate(() => { env.background = bg.value; }));
    const br = h('input', { type: 'range', min: '0.3', max: '2', step: '0.05', value: env.brightness == null ? 1 : env.brightness });
    br.addEventListener('change', () => mutate(() => { env.brightness = +br.value; }));
    p.append(h('div', { class: 'sec' }, h('h4', {}, 'Aparência'), field('Brilho das luzes', br), field('Cor do fundo (vista pelas janelas)', bg)));
    p.append(h('div', { class: 'sec' }, h('h4', {}, 'Visitante'),
      h('p', { class: 'muted small-text' }, 'O boneco azul marca onde o visitante começa e para onde olha (seta).'),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => select('__spawn') }, 'Selecionar o boneco'),
        h('button', { type: 'button', onclick: () => setFirstPerson(true) }, '👁 Ver como visitante'))));
  }
  p.append(introSection());
  p.append(publishSection());
}

function spawnProps(p) {
  p.append(h('h3', {}, 'Ponto inicial do visitante'));
  p.append(h('p', { class: 'muted' }, 'Arraste as setas para mover o visitante. No modo "Girar", gire para escolher para onde ele olha ao entrar.'));
  const pos = env.camera.position;
  const mk = (k) => { const i = h('input', { type: 'number', step: '0.05', value: (+pos[k]).toFixed(2) }); i.addEventListener('change', () => mutate(() => { const c = env.camera; c.position = c.position.slice(); c.position[k] = +i.value || 0; }, { rebuild: false })); return i; };
  const yaw = h('input', { type: 'number', step: '5', value: E.cameraYawDeg(env.camera).toFixed(0) });
  yaw.addEventListener('change', () => mutate(() => { env.camera = { position: env.camera.position, yaw: +yaw.value || 0 }; }, { rebuild: false }));
  p.append(h('div', { class: 'sec' },
    field('Posição X · Altura dos olhos · Z (m)', h('div', { class: 'xyz' }, mk(0), mk(1), mk(2))),
    field('Direção do olhar (graus)', yaw),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => mutate(() => { env.camera = { position: [r4(orbit.target.x), E.EYE, r4(orbit.target.z)], yaw: envYawFromCamera() }; }, { rebuild: false }) }, 'Pôr no centro da vista'),
      h('button', { type: 'button', onclick: () => setFirstPerson(true) }, '👁 Ver como visitante'))));
}

function nodeProps(p, f) {
  const n = f.node;
  p.append(h('h3', {}, n.name || 'Objeto'));
  const kind = n.mesh ? (n.mesh.primitive ? 'Forma: ' + n.mesh.primitive : n.mesh.file ? 'Modelo importado' : 'Modelo: ' + n.mesh.model + ' / ' + n.mesh.name) : n.light ? 'Luz' : 'Grupo';
  p.append(h('div', { class: 'sec' },
    field('Nome', bindText(h('input'), () => n.name, (v) => { n.name = v; }, () => { const s = $('#tree .sel .nm'); if (s) s.textContent = n.name; })),
    h('p', { class: 'muted small-text', style: 'margin:0 0 8px' }, kind),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !n.hidden, onchange: (e) => mutate(() => { if (e.target.checked) delete n.hidden; else n.hidden = true; }) }), 'Visível'),
    n.mesh && n.mesh.primitive && n.mesh.primitive !== 'marker' ? field('Cor', (() => { const i = h('input', { type: 'color', value: n.mesh.color || '#cccccc' }); i.addEventListener('change', () => mutate(() => { n.mesh.color = i.value; })); return i; })()) : null,
    n.light && n.light.hex !== undefined ? lightFields(n) : null));
  p.append(transformSection(n));
  p.append(interactionSection(n, true));
  p.append(h('div', { class: 'sec danger-zone' },
    h('button', { type: 'button', onclick: () => dropToFloor(n.id) }, '⤓ No chão'),
    h('button', { type: 'button', onclick: duplicateSelected }, 'Duplicar'),
    f.parent ? h('button', { type: 'button', onclick: () => select(f.parent.id) }, 'Selecionar grupo') : null,
    h('button', { type: 'button', class: 'danger', onclick: deleteSelected }, 'Excluir')));
}
function lightFields(n) {
  const L = n.light;
  const c = h('input', { type: 'color', value: L.hex || '#ffffff' }); c.addEventListener('change', () => mutate(() => { L.hex = c.value; }));
  const i = h('input', { type: 'range', min: '0.1', max: '4', step: '0.1', value: L.intensity || 1 }); i.addEventListener('change', () => mutate(() => { L.intensity = +i.value; }));
  const r = h('input', { type: 'number', min: '0', max: '30', step: '0.5', value: L.range || 0 }); r.addEventListener('change', () => mutate(() => { L.range = +r.value; }));
  return h('div', {}, field('Cor da luz', c), field('Intensidade', i), field('Alcance (m, 0 = infinito)', r));
}

function hotspotProps(p, f) {
  const hs = f.node;
  p.append(h('h3', {}, hs.name || 'Ponto'));
  const size = h('input', { type: 'range', min: '0.6', max: '4', step: '0.1', value: hs.size || 1.6 });
  size.addEventListener('change', () => mutate(() => { hs.size = +size.value; }));
  p.append(h('div', { class: 'sec' },
    field('Nome (só no editor)', bindText(h('input'), () => hs.name, (v) => { hs.name = v; }, () => { const s = $('#tree .sel .nm'); if (s) s.textContent = hs.name; })),
    field('Legenda na foto (opcional)', (() => { const i = bindText(h('input', { placeholder: 'Ex.: Tapete' }), () => hs.label, (v) => { hs.label = v; }); i.addEventListener('change', () => rebuild()); return i; })()),
    field('Tamanho do sinal', size),
    h('p', { class: 'muted small-text' }, 'Arraste o sinal na foto para mudá-lo de lugar.')));
  p.append(interactionSection(hs, false));
  p.append(h('div', { class: 'sec danger-zone' },
    h('button', { type: 'button', onclick: duplicateSelected }, 'Duplicar'),
    h('button', { type: 'button', class: 'danger', onclick: deleteSelected }, 'Excluir')));
}

function renderProps() {
  const p = $('#props');
  p.innerHTML = '';
  p.className = 'right panel props';
  tfFields = null;
  if (!env) return;
  if (selectedId === '__spawn' && env.type === 'model') return spawnProps(p);
  const f = findSelected();
  if (!f) return envProps(p);
  if (f.hotspot) return hotspotProps(p, f);
  return nodeProps(p, f);
}

// ====================================================================== biblioteca (adicionar)
const SHAPES = [
  { sym: '■', name: 'Caixa', sub: 'móvel simples, degrau', node: { name: 'Caixa', position: [0, 0, 0], scale: [0.5, 0.5, 0.5], mesh: { primitive: 'box', color: '#b08d6a' } } },
  { sym: '▬', name: 'Tapete / placa', sub: 'área no chão', node: { name: 'Tapete', position: [0, 0.005, 0], scale: [1.2, 1, 0.8], mesh: { primitive: 'plane', color: '#8e5a9e' } } },
  { sym: '●', name: 'Cilindro', sub: 'banqueta, lixeira', node: { name: 'Cilindro', position: [0, 0, 0], scale: [0.4, 0.5, 0.4], mesh: { primitive: 'cylinder', color: '#9aa5a5' } } },
  { sym: '◯', name: 'Esfera', sub: 'objeto no chão', node: { name: 'Esfera', position: [0, 0, 0], scale: [0.2, 0.2, 0.2], mesh: { primitive: 'sphere', color: '#e0a030' } } },
  { sym: '!', name: 'Marcador de risco', sub: 'sinal flutuante', node: { name: 'Marcador de risco', position: [0, 1.2, 0], mesh: { primitive: 'marker' }, interactive: { kind: 'risco', title: '', text: '', audio: null, action: null } } },
  { sym: '✓', name: 'Marcador de prevenção', sub: 'sinal flutuante', node: { name: 'Marcador de prevenção', position: [0, 1.2, 0], mesh: { primitive: 'marker' }, interactive: { kind: 'prevencao', title: '', text: '', audio: null, action: null } } },
  { sym: 'i', name: 'Marcador de informação', sub: 'sinal flutuante', node: { name: 'Informação', position: [0, 1.2, 0], mesh: { primitive: 'marker' }, interactive: { kind: 'info', title: '', text: '', audio: null, action: null } } },
  { sym: '✺', name: 'Luz', sub: 'lâmpada extra', node: { name: 'Luz', position: [0, 2.3, 0], light: { type: 'point', hex: '#fff3e0', intensity: 1, range: 5 } } },
  { sym: '⌂', name: 'Ícone "voltar ao menu"', sub: 'como nos originais', node: { name: 'icone-home', position: [0, 0.9, 0], rotation: [-0.7071, 0, 0, 0.7071], scale: [100, 100, 100], materials: ['casinha'], mesh: { model: 'icone-home', name: 'Cube' }, interactive: { kind: 'info', title: '', text: '', audio: null, action: 'menu' } } }
];
let LIB = null;
function openAdd() {
  if (env.type === 'photo') { setPlacing(!placing); return; }
  if (!LIB) LIB = E.libraryFromOriginals();
  const dlg = $('#dlg-add');
  const grid = $('#lib-orig');
  const draw = () => {
    const q = $('#lib-search').value.trim().toLowerCase();
    grid.innerHTML = '';
    LIB.filter((it) => !q || it.name.toLowerCase().includes(q)).forEach((it) => grid.append(h('button', { type: 'button', onclick: () => { dlg.close(); addNode(it.node); } },
      h('b', {}, it.name.replace(/-/g, ' ')), h('small', {}, it.from + (it.node.interactive ? ' · com áudio' : '')))));
  };
  $('#lib-search').oninput = draw;
  draw();
  $('#lib-shapes').innerHTML = '';
  SHAPES.forEach((s) => $('#lib-shapes').append(h('button', { type: 'button', onclick: () => { dlg.close(); addNode(s.node); } }, h('span', { class: 'sym' }, s.sym), h('b', {}, s.name), h('small', {}, s.sub))));
  const used = {};
  E.eachNode(env.nodes, (n) => { if (n.mesh && n.mesh.file) used[n.mesh.file] = n.name; });
  $('#lib-import').innerHTML = '';
  Object.entries(used).forEach(([file, name]) => $('#lib-import').append(h('button', { type: 'button', onclick: () => { dlg.close(); addNode({ name, position: [0, 0, 0], mesh: { file } }); } }, h('b', {}, name), h('small', {}, 'já usado neste ambiente'))));
  dlg.showModal();
}
$$('#add-tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#add-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('#dlg-add .tab').forEach((t) => { t.hidden = t.dataset.tab !== b.dataset.tab; });
}));
$('#glb-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    toast('Enviando modelo…');
    const base = f.name.replace(/\.glb$/i, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'modelo';
    const res = await api.upload(envId, 'modelo-' + base + '-' + E.uid() + '.glb', f);
    $('#dlg-add').close();
    await addNode({ name: base, position: [0, 0, 0], mesh: { file: res.path } });
    toast('Modelo adicionado');
  } catch (err) { toast('Erro: ' + err.message, true); }
});

// ====================================================================== abrir / fechar ambiente
async function openEnv(id) {
  try {
    env = await api.get(id);
  } catch (e) { toast('Não foi possível abrir: ' + e.message, true); return; }
  envId = id;
  undo = []; redo = []; selectedId = null; placing = false; fpMode = false;
  envIndex = await api.list().catch(() => []);
  // grupos grandes (paredes, portas... dos comodos originais) comecam recolhidos
  collapsed.clear();
  (env.nodes || []).forEach((n) => { if (n.children && n.children.length > 8) collapsed.add(n.id); });
  $('#home').hidden = true; $('#workspace').hidden = false;
  $('#crumb').hidden = false; $('#ws-actions').hidden = false;
  $('#env-name').value = env.name || '';
  setStatus('Salvo');
  updateUndoButtons();
  history.replaceState(null, '', '#' + id);
  const photo = env.type === 'photo';
  $('#vp-toolbar').hidden = photo; $('#vp-toolbar-photo').hidden = !photo;
  $('#left-title').textContent = photo ? 'Pontos marcados' : 'Objetos';
  $('#btn-add').textContent = photo ? '+ Colocar ponto' : '+ Adicionar';
  $('#btn-fp').classList.remove('on');
  hint(null);
  window.dispatchEvent(new Event('resize'));
  orbit.enabled = !photo;
  camera.fov = photo ? 75 : 60; camera.updateProjectionMatrix();
  if (photo) { camera.position.set(0, E.EYE, 0); setLookFromEnvYaw(E.cameraYawDeg(env.camera)); }
  renderTree(); renderProps();
  await rebuild();
  if (!photo) frameAll();
  if (!env.thumb) setTimeout(captureThumb, 800);
}

async function closeEnv() {
  if (env) {
    if (fpMode) setFirstPerson(false);
    await saveNow();
    await captureThumb();
  }
  env = null; envId = null; ctx = null; selectedId = null;
  transform.detach(); E.clearWorld(world); spawnObj.visible = false; selBox.visible = false;
  kindBoxes.forEach((b) => helpers.remove(b)); kindBoxes = [];
  $('#home').hidden = false; $('#workspace').hidden = true;
  $('#crumb').hidden = true; $('#ws-actions').hidden = true;
  history.replaceState(null, '', location.pathname);
  renderHome();
}

// ====================================================================== lista de ambientes
async function renderHome() {
  const grid = $('#env-grid');
  let list = [];
  try { list = await api.list(); } catch (e) { toast('Servidor do editor não respondeu. Rode "npm start".', true); }
  grid.innerHTML = '';
  $('#empty-msg').hidden = list.length > 0;
  list.forEach((a) => {
    const thumb = h('div', { class: 'thumb', onclick: () => openEnv(a.id), title: 'Editar' }, a.thumb ? '' : (a.type === 'photo' ? '360°' : '3D'));
    if (a.thumb) thumb.style.backgroundImage = 'url("' + a.thumb + '?v=' + encodeURIComponent(a.updatedAt || '') + '")';
    grid.append(h('div', { class: 'env-card' }, thumb,
      h('div', { class: 'body' },
        h('div', { class: 'title' }, a.name || a.id),
        h('div', { class: 'badges' },
          h('span', { class: 'badge' }, a.type === 'photo' ? 'Foto 360°' : 'Cômodo 3D'),
          h('span', { class: 'badge' + (a.published ? ' on' : '') }, a.published ? 'No app' : 'Rascunho')),
        h('div', { class: 'btns' },
          h('button', { class: 'primary', onclick: () => openEnv(a.id) }, 'Editar'),
          h('button', { onclick: () => window.open('index.html?amb=' + a.id + '&modo=magic', '_blank') }, '▶ Testar'),
          h('button', { onclick: async () => { await api.duplicate(a.id); renderHome(); } }, 'Duplicar'),
          h('button', { onclick: () => exportPkg(a.id) }, 'Exportar'),
          h('button', { class: 'danger', onclick: () => deleteEnv(a.id, a.name) }, 'Excluir')))));
  });
}
async function deleteEnv(id, name, inside) {
  if (!confirm('Excluir o ambiente "' + (name || id) + '"? Os arquivos (áudios, fotos) dele também serão apagados.')) return;
  await api.remove(id);
  toast('Ambiente excluído');
  if (inside) { env = null; await closeEnv(); } else renderHome();
}
function exportPkg(id) {
  const a = h('a', { href: '/api/ambientes/' + id + '/pacote', download: id + '.prevamb.json' });
  document.body.append(a); a.click(); a.remove();
}
async function createAndOpen(newEnv) {
  const res = await api.create(newEnv);
  await openEnv(res.id);
  return res;
}

// Novo comodo vazio
// o returnValue do <dialog> sobrevive entre aberturas (Esc nao o limpa)
function openDialog(sel) { const d = $(sel); d.returnValue = ''; d.showModal(); }
$('#new-room').addEventListener('click', () => openDialog('#dlg-room'));
$('#dlg-room').addEventListener('close', async () => {
  const d = $('#dlg-room');
  if (d.returnValue !== 'ok') return;
  const f = new FormData(d.querySelector('form'));
  await createAndOpen(E.newRoomEnv(f.get('name'), +f.get('w'), +f.get('d'), +f.get('h')));
});
// Copia de um original
$('#new-copy').addEventListener('click', () => {
  const g = $('#copy-grid');
  g.innerHTML = '';
  E.ORIGINALS.forEach((o) => g.append(h('button', { type: 'button', onclick: async () => {
    $('#dlg-copy').close();
    const e = E.fromUnity(o.key);
    e.name = e.name + ' (cópia)';
    await createAndOpen(e);
  } }, h('img', { src: E.DATA.ui.images[o.image], alt: '' }), E.DATA.scenes[o.key].title)));
  $('#dlg-copy').showModal();
});
// Foto 360
$('#new-photo').addEventListener('click', () => openDialog('#dlg-photo'));
$('#dlg-photo').addEventListener('close', async () => {
  const d = $('#dlg-photo');
  if (d.returnValue !== 'ok') return;
  const form = d.querySelector('form');
  const name = form.elements.name.value, file = form.elements.file.files[0];
  form.elements.file.value = '';
  if (!file) return;
  try {
    toast('Enviando foto…');
    const created = await api.create(E.newPhotoEnv(name, null));
    const up = await api.upload(created.id, 'foto-' + E.uid() + '.' + extFrom(file), file);
    created.photo = up.path;
    await api.save(created.id, created);
    await openEnv(created.id);
  } catch (e) { toast('Erro: ' + e.message, true); }
});
// Importar pacote
$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const res = await api.importPkg(await f.text()); toast('Importado: ' + res.name); renderHome(); } catch (err) { toast('Erro ao importar: ' + err.message, true); }
});

// ====================================================================== barra e atalhos
$('#go-home').addEventListener('click', (e) => { e.preventDefault(); if (env) closeEnv(); });
bindText($('#env-name'), () => env && env.name, (v) => { if (env) env.name = v; });
$('#btn-undo').addEventListener('click', doUndo);
$('#btn-redo').addEventListener('click', doRedo);
$('#btn-test').addEventListener('click', async () => {
  const w = window.open('about:blank', '_blank');
  await saveNow();
  await captureThumb();
  if (w) w.location = 'index.html?amb=' + envId + '&modo=magic';
});
$('#btn-add').addEventListener('click', openAdd);
$('#btn-place').addEventListener('click', () => setPlacing(!placing));
$$('#tool-modes button').forEach((b) => b.addEventListener('click', () => { toolMode = b.dataset.mode; applyToolMode(); }));
$('#btn-floor').addEventListener('click', () => { if (selectedId && selectedId !== '__spawn') dropToFloor(selectedId); });
$('#btn-focus').addEventListener('click', focusSelected);
$('#btn-top').addEventListener('click', () => { if (fpMode) setFirstPerson(false); frameAll(true); });
$('#btn-fp').addEventListener('click', () => setFirstPerson(!fpMode));
$('#btn-clip').addEventListener('click', () => { clipOn = !clipOn; applyClip(); });

window.addEventListener('keydown', (e) => {
  if (!env) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedId && selectedId !== '__spawn') { e.preventDefault(); deleteSelected(); } return; }
  if (e.key === 'Escape') { if (placing) setPlacing(false); else if (fpMode) setFirstPerson(false); else select(null); return; }
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'e' || k === 'r') { toolMode = { w: 'translate', e: 'rotate', r: 'scale' }[k]; applyToolMode(); }
  if (k === 'f') focusSelected();
});

// API para testes automatizados
window.PrevEditor = {
  openEnv, closeEnv, select, addNode, dropToFloor, captureThumb, saveNow, setFirstPerson, mutate,
  get env() { return env; }, get envId() { return envId; }, get selectedId() { return selectedId; }, get ctx() { return ctx; },
  camera, orbit, library: () => (LIB = LIB || E.libraryFromOriginals())
};

// abre direto se a URL tiver #<id>
const startId = location.hash.slice(1);
if (startId) openEnv(startId); else renderHome();
