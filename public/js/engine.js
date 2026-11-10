/* global AFRAME, THREE */
/*
 * Motor compartilhado pelo app (index.html) e pelo editor (editor.html).
 *
 * Um "ambiente" e um JSON:
 * {
 *   id, name, type: 'model' | 'photo', published, thumb,
 *   camera: { position:[x,y,z], rotation:[qx,qy,qz,qw] } ou { position, yaw (graus) }
 *           (o visitante olha para +Z local do rig, como no Unity)
 *   background: '#rrggbb', brightness: 1,
 *   intro: { text, audio }                       narracao ao entrar
 *   -- type 'model'
 *   lighting: 'unity' | 'room', ambient: { sky:[r,g,b] }
 *   room: { width, depth, height, floorColor, wallColor, floorTexture, ceiling }   comodo gerado (opcional)
 *   nodes: [ { id, name, position, rotation(quat), scale, hidden,
 *              mesh: {model,name} (Unity) | {file:'url.glb'} | {primitive:'box'|'cylinder'|'sphere'|'plane'|'marker', color},
 *              materials:[id], box:{center,size}, light:{...},
 *              interactive: { kind:'risco'|'prevencao'|'info', title, text, audio, action: null|'menu'|'amb:<id>' },
 *              children:[...] } ]
 *   -- type 'photo'
 *   photo: 'url.jpg' (equiretangular), hotspots: [ { id, name, yaw, pitch, interactive } ]
 * }
 */
(function () {
  'use strict';

  var DATA = window.PREV_DATA;
  var ORIGINALS = [
    { index: 2, key: '2-Quarto', image: 'prev-quarto' },
    { index: 3, key: '3-Quarto-risco', image: 'risco-quarto' },
    { index: 4, key: '4-Banheiro', image: 'prev-banheiro' },
    { index: 5, key: '5-Banheiro-risco', image: 'risco-banheiro' }
  ];
  var KINDS = {
    risco: { label: 'Risco', color: '#d93b3b', symbol: '!' },
    prevencao: { label: 'Prevenção', color: '#2e9e5b', symbol: '✓' },
    info: { label: 'Informação', color: '#2b7bd9', symbol: 'i' }
  };
  var EYE = 1.6;
  var PHOTO_RADIUS = 4;

  // ------------------------------------------------------------------ util
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function srgb(c) { return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); }
  function eachNode(nodes, fn, parent) {
    (nodes || []).forEach(function (n) { fn(n, parent); eachNode(n.children, fn, n); });
  }
  function findNode(nodes, id) {
    var r = null;
    eachNode(nodes, function (n, p) { if (!r && n.id === id) r = { node: n, parent: p }; });
    return r;
  }
  function assignIds(nodes) { eachNode(nodes, function (n) { if (!n.id) n.id = uid(); }); return nodes; }
  function dirFromYawPitch(yawDeg, pitchDeg) {
    var y = THREE.MathUtils.degToRad(yawDeg || 0), p = THREE.MathUtils.degToRad(pitchDeg || 0);
    return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
  }
  function yawPitchFromDir(d) {
    d = d.clone().normalize();
    return { yaw: THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z)), pitch: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1))) };
  }

  // Interacao no formato novo (aceita o formato exportado do Unity: {audio, hover, scene})
  function normInteractive(it) {
    if (!it) return null;
    var kind = it.kind || (it.hover === 'risco' ? 'risco' : it.hover === 'prevencao' ? 'prevencao' : 'info');
    var action = it.action || null;
    if (!action && it.scene != null) action = (it.scene === 1 || it.scene === 'menu') ? 'menu' : null;
    return { kind: kind, title: it.title || '', text: it.text || '', audio: it.audio || null, action: action, hover: it.hover || null };
  }

  // ------------------------------------------------------------------ cenas originais (Unity) -> ambiente
  function cameraFromChain(chain) {
    var m = new THREE.Matrix4();
    (chain || []).forEach(function (n) {
      m.multiply(new THREE.Matrix4().compose(new THREE.Vector3().fromArray(n.position), new THREE.Quaternion().fromArray(n.rotation), new THREE.Vector3(1, 1, 1)));
    });
    var p = new THREE.Vector3(), q = new THREE.Quaternion();
    m.decompose(p, q, new THREE.Vector3());
    return { position: p.toArray().map(round), rotation: q.toArray().map(round) };
  }
  function round(v) { return Math.round(v * 10000) / 10000; }

  function fromUnity(key) {
    var s = DATA.scenes[key];
    if (!s) return null;
    var nodes = assignIds(clone(s.nodes));
    eachNode(nodes, function (n) { if (n.interactive) n.interactive = normInteractive(n.interactive); });
    return {
      type: 'model',
      name: s.title,
      source: key,
      lighting: 'unity',
      ambient: s.ambient,
      background: '#9fb6bf',
      brightness: 1,
      camera: s.camera && s.camera.length ? cameraFromChain(s.camera) : { position: [0, EYE, 0], yaw: 0 },
      intro: { text: '', audio: (s.autoplay || [])[0] || null },
      nodes: nodes
    };
  }

  function newRoomEnv(name, w, d, h) {
    return {
      type: 'model', name: name || 'Novo cômodo', lighting: 'room', background: '#9fb6bf', brightness: 1,
      room: { width: w || 4, depth: d || 4, height: h || 2.7, floorColor: '#c8b59a', wallColor: '#e8e4dc', floorTexture: 'lajota-madeira-gimp', ceiling: true },
      camera: { position: [0, EYE, (d || 4) / 2 - 0.6], yaw: 180 },
      intro: { text: '', audio: null },
      nodes: []
    };
  }

  function newPhotoEnv(name, photo) {
    return {
      type: 'photo', name: name || 'Foto 360°', photo: photo, background: '#000000', brightness: 1,
      camera: { position: [0, EYE, 0], yaw: 0 }, intro: { text: '', audio: null }, hotspots: []
    };
  }

  function cameraQuaternion(cam) {
    if (cam && cam.rotation) return new THREE.Quaternion().fromArray(cam.rotation);
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad((cam && cam.yaw) || 0), 0));
  }
  function cameraYawDeg(cam) {
    var f = new THREE.Vector3(0, 0, 1).applyQuaternion(cameraQuaternion(cam));
    return THREE.MathUtils.radToDeg(Math.atan2(f.x, f.z));
  }

  // ------------------------------------------------------------------ materiais
  var textureLoader = new THREE.TextureLoader();
  var textureCache = {};
  var materialCache = {};
  function texture(url, repeat, offset, flipY) {
    var key = url + '|' + (repeat || '') + '|' + (offset || '') + '|' + flipY;
    if (!textureCache[key]) {
      var t = textureLoader.load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = !!flipY;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      if (repeat) t.repeat.set(repeat[0], repeat[1]);
      if (offset) t.offset.set(offset[0], offset[1]);
      textureCache[key] = t;
    }
    return textureCache[key];
  }
  function material(id) {
    if (!id) return null;
    if (materialCache[id]) return materialCache[id];
    var d = DATA.materials[id];
    if (!d) return null;
    var m = new THREE.MeshStandardMaterial({
      name: id, color: srgb(d.color), metalness: d.metalness, roughness: Math.max(0.15, d.roughness),
      transparent: !!d.transparent, opacity: d.opacity, depthWrite: !d.transparent
    });
    if (d.map) m.map = texture(d.map, d.repeat, d.offset, false); // UVs do glTF ja invertidos em relacao ao Unity
    if (d.emissive) m.emissive = srgb(d.emissive);
    materialCache[id] = m;
    return m;
  }
  var hoverCache = {};
  function hoverMaterial(it) {
    if (it.hover && DATA.materials[it.hover]) return material(it.hover);
    if (it.kind === 'risco' && DATA.materials.risco) return material('risco');
    if (it.kind === 'prevencao' && DATA.materials.prevencao) return material('prevencao');
    var c = (KINDS[it.kind] || KINDS.info).color;
    if (!hoverCache[c]) hoverCache[c] = new THREE.MeshStandardMaterial({ color: c, emissive: new THREE.Color(c).multiplyScalar(0.35), roughness: 0.6 });
    return hoverCache[c];
  }
  function colorMaterial(hex) {
    var k = 'c' + hex;
    if (!materialCache[k]) materialCache[k] = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex || '#cccccc'), roughness: 0.8, metalness: 0 });
    return materialCache[k];
  }

  // ------------------------------------------------------------------ modelos glTF
  var gltfLoader = new THREE.GLTFLoader();
  var gltfCache = {};
  function loadGltf(url) {
    if (!gltfCache[url]) {
      gltfCache[url] = new Promise(function (resolve, reject) { gltfLoader.load(url, resolve, undefined, reject); });
      gltfCache[url].catch(function () { delete gltfCache[url]; });
    }
    return gltfCache[url];
  }
  function unityModelUrl(name) { return 'assets/models/' + name + '.glb'; }
  function meshFrom(gltf, meshName) {
    var idx = gltf.parser.json.meshes.findIndex(function (m) { return m.name === meshName; });
    if (idx < 0) return Promise.resolve(null);
    return gltf.parser.getDependency('mesh', idx).then(function (obj) {
      // o GLTFLoader reutiliza o objeto da malha como no e aplica nele a transformacao do no;
      // so queremos a geometria crua (a transformacao vem do ambiente)
      var c = obj.clone();
      c.position.set(0, 0, 0); c.quaternion.identity(); c.scale.set(1, 1, 1);
      return c;
    });
  }

  // Sinal (marcador) em canvas: circulo colorido com simbolo
  var markerTex = {};
  function markerTexture(kind) {
    if (markerTex[kind]) return markerTex[kind];
    var k = KINDS[kind] || KINDS.info;
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d');
    g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.95)'; g.fill();
    g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.fillStyle = k.color; g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 140px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(k.symbol, 128, 138);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    markerTex[kind] = t;
    return t;
  }
  function makeMarker(kind, size) {
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTexture(kind), depthTest: false, transparent: true, toneMapped: false }));
    s.renderOrder = 10;
    s.scale.set(size, size, 1);
    s.userData.isMarker = true;
    return s;
  }

  function primitiveMesh(p) {
    var geo;
    switch (p.primitive) {
      case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
      case 'sphere': geo = new THREE.SphereGeometry(0.5, 32, 16); break;
      case 'plane': geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2); break;
      default: geo = new THREE.BoxGeometry(1, 1, 1);
    }
    var m = new THREE.Mesh(geo, colorMaterial(p.color));
    if (p.primitive === 'plane') m.material = colorMaterial(p.color).clone(), m.material.side = THREE.DoubleSide;
    return m;
  }

  // ------------------------------------------------------------------ montagem
  function setTRS(obj, n) {
    if (n.position) obj.position.fromArray(n.position);
    if (n.rotation) obj.quaternion.fromArray(n.rotation);
    if (n.scale) obj.scale.fromArray(n.scale);
  }

  /*
   * ctx = { world, entities:{id:el}, pending:[promises], lights:[], onActivate(info, el), editor:bool }
   */
  function buildNode(n, parentEl, ctx) {
    var firstPending = ctx.pending.length;
    var el = document.createElement('a-entity');
    el.setAttribute('data-name', n.name || '');
    el.dataset.nodeId = n.id;
    parentEl.appendChild(el);
    setTRS(el.object3D, n);
    ctx.entities[n.id] = el;

    var it = normInteractive(n.interactive);
    var meshReady = Promise.resolve(null);

    if (n.mesh && !n.hidden) {
      var mk = n.mesh;
      if (mk.primitive === 'marker') {
        var marker = makeMarker(it ? it.kind : 'info', 0.25);
        el.setObject3D('mesh', marker);
        meshReady = Promise.resolve(marker);
      } else if (mk.primitive) {
        var pm = primitiveMesh(mk);
        el.setObject3D('mesh', pm);
        meshReady = Promise.resolve(pm);
      } else if (mk.model || mk.file) {
        var url = mk.file || unityModelUrl(mk.model);
        meshReady = loadGltf(url).then(function (gltf) {
          if (mk.file) {
            var sc = gltf.scene.clone(true);
            sc.traverse(function (o) { if (o.isMesh && o.material) { o.material = o.material.clone(); } });
            return sc;
          }
          return meshFrom(gltf, mk.name).then(function (obj) {
            if (!obj) return null;
            var meshes = [];
            obj.traverse(function (o) { if (o.isMesh) meshes.push(o); });
            meshes.forEach(function (o, i) {
              var m = n.materials && material(n.materials[i] || n.materials[0]);
              if (m) o.material = m;
              else if (o.material) {
                o.material = o.material.clone();
                if (o.material.roughness !== undefined) o.material.roughness = Math.max(o.material.roughness, 0.6);
                if (o.material.metalness !== undefined) o.material.metalness = Math.min(o.material.metalness, 0.2);
              }
              if (o.material && o.material.transparent) o.material.depthWrite = false;
            });
            return obj;
          });
        }).then(function (obj) {
          if (obj && el.parentNode) el.setObject3D('mesh', obj);
          return obj;
        }).catch(function (e) { console.warn('modelo nao carregou', url, e); return null; });
      }
      ctx.pending.push(meshReady);
    }

    if (n.light) ctx.lights.push({ el: el, def: n.light });

    (n.children || []).forEach(function (c) { buildNode(c, el, ctx); });

    // a caixa de selecao cobre o objeto e as pecas dele (ex.: "Cama completa")
    if (it && !n.hidden) addInteraction(n, el, it, Promise.all(ctx.pending.slice(firstPending)), ctx);
    return el;
  }

  function addInteraction(n, el, it, subtreeReady, ctx) {
    var isMarker = n.mesh && n.mesh.primitive === 'marker';
    var makeHit = function (center, size) {
      var hit = document.createElement('a-entity');
      hit.setAttribute('position', center.join(' '));
      hit.setAttribute('geometry', { primitive: 'box', width: Math.max(size[0], 1e-4), height: Math.max(size[1], 1e-4), depth: Math.max(size[2], 1e-4) });
      hit.setAttribute('material', { visible: false });
      hit.addEventListener('loaded', function () { var m = hit.getObject3D('mesh'); if (m) m.userData.isHitBox = true; });
      hit.dataset.hitFor = n.id;
      el.appendChild(hit);
      wire(hit);
    };
    var wire = function (hit) {
      hit.classList.add('clickable');
      hit.userDataHover = isMarker ? null : hoverMaterial(it);
      hit.setAttribute('interactive', { target: el, marker: isMarker });
      hit.addEventListener('click', function () { if (ctx.onActivate) ctx.onActivate(it, el, n); });
    };
    if (isMarker) {
      makeHit([0, 0, 0], [0.3, 0.3, 0.3]);
    } else if (n.box) {
      makeHit(n.box.center, n.box.size);
    } else {
      // sem BoxCollider: usa a caixa envolvente das malhas (no espaco local do objeto)
      subtreeReady.then(function () {
        if (!el.parentNode) return;
        var box = new THREE.Box3();
        el.object3D.updateMatrixWorld(true);
        var inv = new THREE.Matrix4().copy(el.object3D.matrixWorld).invert();
        el.object3D.traverse(function (o) {
          if (!o.isMesh || !o.geometry || o.userData.isHitBox || (o.material && o.material.visible === false)) return;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          var b = o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
          box.union(b);
        });
        if (box.isEmpty()) return;
        var c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
        makeHit(c.toArray(), s.toArray());
      });
    }
  }

  // Comodo gerado: piso, paredes e teto voltados para dentro (de fora ficam "transparentes", bom para o editor)
  function buildRoomShell(room, world) {
    var w = room.width || 4, d = room.depth || 4, h = room.height || 2.7;
    var g = new THREE.Group();
    g.name = 'room-shell';
    var floorMat;
    if (room.floorTexture) {
      var t = texture('assets/textures/' + room.floorTexture + '.png', null, null, true).clone();
      t.needsUpdate = true;
      t.repeat.set(w / 1.2, d / 1.2);
      floorMat = new THREE.MeshStandardMaterial({ map: t, color: new THREE.Color(room.floorColor || '#ffffff').lerp(new THREE.Color('#ffffff'), 0.5), roughness: 0.8 });
    } else {
      floorMat = new THREE.MeshStandardMaterial({ color: room.floorColor || '#c8b59a', roughness: 0.85 });
    }
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI / 2;
    g.add(floor);
    var wallMat = new THREE.MeshStandardMaterial({ color: room.wallColor || '#e8e4dc', roughness: 0.95 });
    var walls = [
      [w, [0, h / 2, -d / 2], 0], [w, [0, h / 2, d / 2], Math.PI],
      [d, [-w / 2, h / 2, 0], Math.PI / 2], [d, [w / 2, h / 2, 0], -Math.PI / 2]
    ];
    walls.forEach(function (wd) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(wd[0], h), wallMat);
      m.position.fromArray(wd[1]); m.rotation.y = wd[2];
      g.add(m);
    });
    // rodape
    var skirtMat = new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.7 });
    walls.forEach(function (wd) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(wd[0], 0.08), skirtMat);
      m.position.set(wd[1][0], 0.04, wd[1][2]); m.rotation.y = wd[2];
      m.translateZ(0.003);
      g.add(m);
    });
    if (room.ceiling !== false) {
      var c = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: '#f7f7f5', roughness: 1 }));
      c.rotation.x = Math.PI / 2; c.position.y = h;
      g.add(c);
    }
    world.object3D.add(g);
    return g;
  }

  function addLights(env, ctx, rigPos) {
    var world = ctx.world;
    var k = env.brightness == null ? 1 : env.brightness;
    var add = function (def) { var e = document.createElement('a-entity'); e.setAttribute('light', def); world.appendChild(e); return e; };
    if (env.lighting === 'unity') {
      var sky = env.ambient && env.ambient.sky ? '#' + srgb(env.ambient.sky).getHexString() : '#ffffff';
      add({ type: 'hemisphere', color: '#ffffff', groundColor: '#8a8070', intensity: 0.9 * k });
      add({ type: 'ambient', color: sky, intensity: 0.8 * k });
      ctx.lights.forEach(function (l) {
        var d = l.def;
        if (d.hex !== undefined) { // luz adicionada no editor
          l.el.setAttribute('light', { type: 'point', color: d.hex, intensity: (d.intensity || 1) * k, distance: d.range || 0, decay: d.range ? 1 : 0 });
          return;
        }
        var color = '#' + srgb(d.color).getHexString();
        if (d.type === 'directional') {
          l.el.object3D.updateMatrixWorld(true);
          var dir = new THREE.Vector3(0, 0, 1).applyQuaternion(l.el.object3D.getWorldQuaternion(new THREE.Quaternion()));
          var light = new THREE.DirectionalLight(color, d.intensity * 0.8 * k);
          light.position.copy(dir).multiplyScalar(-10);
          var holder = new THREE.Object3D();
          holder.add(light); holder.add(light.target);
          holder.position.copy(rigPos);
          world.object3D.add(holder);
        } else if (d.type === 'point' || d.type === 'spot') {
          l.el.setAttribute('light', { type: 'point', color: color, intensity: d.intensity * 1.5 * k, distance: d.range * 1.5, decay: 1 });
        } else if (d.type === 'area') {
          l.el.setAttribute('light', { type: 'point', color: color, intensity: d.intensity * 1.2 * k, distance: 0, decay: 0 });
        }
      });
      return;
    }
    var h = (env.room && env.room.height) || 2.7;
    add({ type: 'hemisphere', color: '#ffffff', groundColor: '#9a9080', intensity: 1.1 * k });
    add({ type: 'ambient', color: '#ffffff', intensity: 0.45 * k });
    var p = add({ type: 'point', color: '#fff6e8', intensity: 1.4 * k, distance: 0, decay: 0 });
    p.setAttribute('position', '0 ' + (h - 0.3) + ' 0');
    var dl = new THREE.DirectionalLight('#ffffff', 0.6 * k);
    dl.position.set(2, 5, 3);
    world.object3D.add(dl);
    // luzes adicionadas como objetos no editor
    ctx.lights.forEach(function (l) {
      var d = l.def;
      l.el.setAttribute('light', { type: 'point', color: d.hex || '#ffffff', intensity: (d.intensity || 1) * k, distance: d.range || 0, decay: d.range ? 1 : 0 });
    });
  }

  function buildPhoto(env, ctx) {
    var world = ctx.world;
    var sky = document.createElement('a-sky');
    sky.setAttribute('radius', 50);
    sky.setAttribute('material', { shader: 'flat', side: 'back', npot: true });
    sky.setAttribute('src', env.photo);
    sky.dataset.photo = '1';
    world.appendChild(sky);
    ctx.pending.push(new Promise(function (r) {
      sky.addEventListener('materialtextureloaded', function () { r(); });
      sky.addEventListener('materialtextureloaderror', function () { r(); });
      setTimeout(r, 15000);
    }));
    var amb = document.createElement('a-entity');
    amb.setAttribute('light', { type: 'ambient', intensity: 2 });
    world.appendChild(amb);
    (env.hotspots || []).forEach(function (h) {
      var n = { id: h.id, name: h.name, mesh: { primitive: 'marker' }, interactive: h.interactive || { kind: 'info' } };
      var pos = dirFromYawPitch(h.yaw, h.pitch).multiplyScalar(PHOTO_RADIUS).add(new THREE.Vector3(0, EYE, 0));
      n.position = pos.toArray();
      var el = buildNode(n, world, ctx);
      el.object3D.scale.setScalar(h.size || 1.6);
      if (h.label) {
        var lb = document.createElement('a-entity');
        lb.setAttribute('canvas-text', { text: h.label, width: 1.2, height: 0.16, size: 0.62, color: '#ffffff', background: 'rgba(0,0,0,0.55)', radius: 0.4 });
        lb.setAttribute('position', '0 -0.2 0');
        lb.setAttribute('scale', '0.5 0.5 0.5');
        lb.setAttribute('look-at-camera', 'yOnly: false');
        el.appendChild(lb);
      }
    });
  }

  /*
   * Monta um ambiente dentro de opts.world. Devolve Promise<ctx> quando as malhas carregaram.
   * opts: { world, onActivate, editor, rig (THREE.Object3D) }
   */
  function build(env, opts) {
    var ctx = { world: opts.world, entities: {}, pending: [], lights: [], onActivate: opts.onActivate, editor: !!opts.editor, shell: null };
    var rigPos = new THREE.Vector3().fromArray((env.camera && env.camera.position) || [0, EYE, 0]);
    if (opts.rig) {
      opts.rig.position.copy(env.type === 'photo' ? new THREE.Vector3(0, EYE, 0) : rigPos);
      opts.rig.quaternion.copy(cameraQuaternion(env.camera));
    }
    if (env.type === 'photo') {
      buildPhoto(env, ctx);
    } else {
      if (env.room) ctx.shell = buildRoomShell(env.room, opts.world);
      (env.nodes || []).forEach(function (n) { buildNode(n, opts.world, ctx); });
      // as luzes direcionais dependem das matrizes, que ficam prontas apos montar as entidades
      ctx.pending.push(new Promise(function (r) { setTimeout(r, 0); }).then(function () { addLights(env, ctx, rigPos); }));
    }
    return Promise.all(ctx.pending).then(function () { return ctx; });
  }

  function clearWorld(world) {
    while (world.firstChild) world.removeChild(world.firstChild);
    world.object3D.children.slice().forEach(function (c) { if (!c.el) world.object3D.remove(c); });
  }

  // Objetos dos comodos originais que podem ser reutilizados em ambientes novos
  var SKIP = /^(parede|chao|teto|vidro|janela|porta-|moldura|maçaneta|puxador-porta|icone-home|Cube$)/i;
  // moveis que no Unity sao varias pecas: viram um item unico (grupo) na biblioteca
  var PRESETS = [
    { name: 'Cama completa', scene: '2-Quarto', parts: ['cama', 'cabeceira-cama', 'pes-cama', 'suporte-cama', 'almofada'] },
    { name: 'Guarda-roupa com puxador', scene: '2-Quarto', parts: ['guarda-roupa', 'puxador-guarda-roupa'] },
    { name: 'Rack com TV', scene: '2-Quarto', parts: ['rack-madeira', 'rack-branca', 'rack-puxador', 'tv', 'aparelho'] },
    { name: 'Cadeira', scene: '2-Quarto', parts: ['cadeira'] },
    { name: 'Vaso sanitário completo', scene: '4-Banheiro', parts: ['vaso', 'assento-banheiro-01', 'assento-banheiro-02', 'assento-banheiro-03', 'assento-banheiro-04', 'assento-banheiro-05'] },
    { name: 'Papel higiênico com suporte', scene: '4-Banheiro', parts: ['porta-papel-higienico', 'papel-higienico', 'detalhe-papel-higienico'] },
    { name: 'Sapateira com sapatos', scene: '2-Quarto', parts: ['sapateira'] }
  ];
  function trsOf(m) {
    var p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { position: p.toArray().map(round), rotation: q.toArray().map(round), scale: s.toArray().map(round) };
  }
  function libraryFromOriginals() {
    var items = [], seen = {}, byScene = {};
    ORIGINALS.forEach(function (o) {
      var s = DATA.scenes[o.key];
      var named = byScene[o.key] = {};
      var walk = function (nodes, parentMatrix) {
        nodes.forEach(function (n) {
          var m = new THREE.Matrix4().compose(
            new THREE.Vector3().fromArray(n.position || [0, 0, 0]),
            new THREE.Quaternion().fromArray(n.rotation || [0, 0, 0, 1]),
            new THREE.Vector3().fromArray(n.scale || [1, 1, 1]));
          var world = new THREE.Matrix4().multiplyMatrices(parentMatrix, m);
          if (!named[n.name]) named[n.name] = { node: n, world: world };
          if (n.mesh && !SKIP.test(n.name) && !SKIP.test(n.mesh.name)) {
            // o quarto com e sem riscos repetem os mesmos moveis: um item por nome + materiais
            var key = n.name + ':' + (n.materials || []).join(',');
            if (!seen[key]) {
              seen[key] = true;
              var p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
              world.decompose(p, q, sc);
              var item = clone(n);
              item.position = [0, 0, 0];
              item.rotation = q.toArray().map(round);
              item.scale = sc.toArray().map(round);
              delete item.id;
              if (item.interactive) item.interactive = normInteractive(item.interactive);
              items.push({ name: n.name, from: s.title, node: item });
            }
            return; // filhos ja vem junto
          }
          if (n.children) walk(n.children, world);
        });
      };
      walk(s.nodes, new THREE.Matrix4());
    });
    items.sort(function (a, b) { return a.name.localeCompare(b.name, 'pt'); });
    // conjuntos prontos no topo
    var sets = [];
    PRESETS.forEach(function (pr) {
      var named = byScene[pr.scene] || {};
      var parts = pr.parts.map(function (nm) { return named[nm]; }).filter(Boolean);
      if (!parts.length) return;
      var c = new THREE.Vector3();
      parts.forEach(function (p) { c.add(new THREE.Vector3().setFromMatrixPosition(p.world)); });
      c.divideScalar(parts.length); c.y = 0;
      var toLocal = new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z);
      var group = { name: pr.name, group: true, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], children: parts.map(function (p) {
        var n = clone(p.node);
        delete n.id;
        eachNode([n], function (x) { delete x.id; if (x.interactive) x.interactive = normInteractive(x.interactive); });
        return Object.assign(n, trsOf(new THREE.Matrix4().multiplyMatrices(toLocal, p.world)));
      }) };
      sets.push({ name: pr.name, from: 'Conjunto · ' + DATA.scenes[pr.scene].title, node: group, set: true });
    });
    return sets.concat(items);
  }

  window.PrevEngine = {
    DATA: DATA, ORIGINALS: ORIGINALS, KINDS: KINDS, EYE: EYE, PHOTO_RADIUS: PHOTO_RADIUS,
    uid: uid, clone: clone, eachNode: eachNode, findNode: findNode, assignIds: assignIds,
    normInteractive: normInteractive, fromUnity: fromUnity, newRoomEnv: newRoomEnv, newPhotoEnv: newPhotoEnv,
    cameraQuaternion: cameraQuaternion, cameraYawDeg: cameraYawDeg, dirFromYawPitch: dirFromYawPitch, yawPitchFromDir: yawPitchFromDir,
    build: build, clearWorld: clearWorld, material: material, loadGltf: loadGltf, makeMarker: makeMarker,
    libraryFromOriginals: libraryFromOriginals, unityModelUrl: unityModelUrl
  };
})();
