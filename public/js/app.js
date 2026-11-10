/* global AFRAME, THREE, PrevEngine */
/*
 * PrevQuedasRV (A-Frame) - app do visitante.
 * Fluxo: Tutorial -> Menu -> comodos originais (2..5) ou ambientes criados no editor.
 * Parametros de URL:
 *   ?cena=3            abre direto numa cena original (0..5)
 *   ?amb=<id>          abre direto um ambiente criado no editor
 *   ?modo=cardboard    pula a tela de entrada (usado pelo app React Native)
 *   ?modo=magic
 */
(function () {
  'use strict';

  var E = window.PrevEngine;
  var DATA = E.DATA;
  var params = new URLSearchParams(location.search);

  var sceneEl = document.querySelector('a-scene');
  var world = document.getElementById('world');
  var rig = document.getElementById('rig');
  var recenter = document.getElementById('recenter');
  var cameraEl = document.getElementById('camera');
  var loadingEl = document.getElementById('loading');
  var current = null;
  var loadToken = 0;
  var envList = []; // ambientes publicados (ambientes/index.json)

  // ------------------------------------------------------------------ audio
  // Um unico elemento para as narracoes: tocar uma nova interrompe a anterior.
  var narration = new Audio();
  narration.preload = 'auto';
  function play(src) {
    if (!src) return;
    narration.pause();
    narration.src = src;
    narration.currentTime = 0;
    var p = narration.play();
    if (p && p.catch) p.catch(function (e) { console.warn('audio bloqueado', e); });
  }
  function stopAudio() { narration.pause(); }

  // ------------------------------------------------------------------ placa de texto
  var panel = null;
  function hidePanel() { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); panel = null; }
  function showPanel(title, text, kind) {
    hidePanel();
    if (!title && !text) return;
    var cam = sceneEl.camera;
    var pos = new THREE.Vector3(), dir = new THREE.Vector3();
    cam.getWorldPosition(pos); cam.getWorldDirection(dir);
    var stereo = sceneEl.systems['stereo-mode'].data.enabled;
    var p = pos.clone().add(dir.clone().multiplyScalar(stereo ? 1.6 : 1.3));
    p.y -= 0.12;
    panel = document.createElement('a-entity');
    var k = E.KINDS[kind] || { color: '#00868a' };
    panel.setAttribute('text-panel', { title: title || '', text: text || '', accent: k.color, width: stereo ? 1.0 : 0.85 });
    panel.setAttribute('position', p.toArray().join(' '));
    panel.setAttribute('look-at-camera', 'yOnly: false'); // de frente mesmo olhando para o chao
    panel.userData = { dir: dir.clone(), born: performance.now() };
    world.appendChild(panel);
  }
  // some quando a pessoa desvia o olhar
  AFRAME.registerComponent('panel-watch', {
    tick: function () {
      if (!panel || !sceneEl.camera) return;
      var d = new THREE.Vector3();
      sceneEl.camera.getWorldDirection(d);
      if (performance.now() - panel.userData.born > 600 && d.angleTo(panel.userData.dir) > THREE.MathUtils.degToRad(40)) hidePanel();
    }
  });
  sceneEl.setAttribute('panel-watch', '');

  function onActivate(it) {
    if (it.action === 'menu') return goTo('menu');
    if (it.action && it.action.indexOf('amb:') === 0) return goTo(it.action);
    if (it.audio) play(it.audio);
    if (it.title || it.text) showPanel(it.title, it.text, it.kind);
  }

  // ------------------------------------------------------------------ ambientes
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ': ' + r.status);
      return r.json();
    });
  }
  function loadEnvList() {
    return fetchJson('ambientes/index.json').then(function (d) {
      envList = (d.ambientes || []).filter(function (a) { return a.published; });
    }).catch(function () { envList = []; });
  }

  function buildEnv(env) {
    var token = loadToken;
    return E.build(env, { world: world, rig: rig.object3D, onActivate: onActivate }).then(function () {
      if (token !== loadToken) return;
      sceneEl.setAttribute('background', 'color', env.background || '#9fb6bf');
      if (env.intro) {
        if (env.intro.audio) play(env.intro.audio);
        if (env.intro.text) setTimeout(function () { if (token === loadToken) showPanel(env.name, env.intro.text, 'info'); }, 300);
      }
    });
  }

  // ------------------------------------------------------------------ telas de interface
  // O canvas do Unity fica 5 m a frente, 8 x 4,5 m (1600 x 900 px * 0,005).
  var PX = 0.005;
  function resetRig() { rig.object3D.position.set(0, E.EYE, 0); rig.object3D.quaternion.identity(); }
  function uiPanel(color) {
    resetRig();
    sceneEl.setAttribute('background', 'color', '#9fb6bf');
    var p = document.createElement('a-entity');
    // No Unity o canvas fica em z=+5 e a camera olha para +Z; aqui o rig tambem olha para +Z
    p.setAttribute('position', '0 1.6 5');
    p.setAttribute('rotation', '0 180 0');
    world.appendChild(p);
    var amb = document.createElement('a-entity');
    amb.setAttribute('light', { type: 'ambient', intensity: 3 });
    world.appendChild(amb);
    var bg = document.createElement('a-entity');
    bg.setAttribute('geometry', { primitive: 'plane', width: 1600 * PX, height: 900 * PX });
    bg.setAttribute('material', { color: color, shader: 'flat' });
    p.appendChild(bg);
    return p;
  }
  function uiImage(parent, src, x, y, w, h, opts) {
    var el = document.createElement('a-entity');
    el.setAttribute('geometry', { primitive: 'plane', width: w * PX, height: h * PX });
    el.setAttribute('material', Object.assign({ src: src, shader: 'flat', transparent: true }, opts || {}));
    el.setAttribute('position', (x * PX) + ' ' + (y * PX) + ' 0.01');
    parent.appendChild(el);
    return el;
  }
  function uiText(parent, text, x, y, w, h, opts) {
    var el = document.createElement('a-entity');
    el.setAttribute('canvas-text', Object.assign({ text: text, width: w * PX, height: h * PX }, opts || {}));
    el.setAttribute('position', (x * PX) + ' ' + (y * PX) + ' 0.02');
    parent.appendChild(el);
    return el;
  }
  function uiButton(el, onClick, base) {
    base = base || '#dbdbdb';
    el.classList.add('clickable');
    el.addEventListener('mouseenter', function () { if (el.hasAttribute('material')) el.setAttribute('material', 'color', '#ffffff'); el.object3D.scale.setScalar(1.06); });
    el.addEventListener('mouseleave', function () { if (el.hasAttribute('material')) el.setAttribute('material', 'color', base); el.object3D.scale.setScalar(1); });
    el.addEventListener('click', onClick);
    return el;
  }
  function uiTextButton(parent, text, x, y, w, h, onClick, bg) {
    var el = uiText(parent, text, x, y, w, h, { color: '#ffffff', background: bg || '#00686a', radius: 0.25, size: 0.5 });
    el.classList.add('clickable');
    el.addEventListener('mouseenter', function () { el.object3D.scale.setScalar(1.06); });
    el.addEventListener('mouseleave', function () { el.object3D.scale.setScalar(1); });
    el.addEventListener('click', onClick);
    return el;
  }

  function buildMenu() {
    var p = uiPanel('#009293');
    var img = DATA.ui.images;
    var shift = envList.length ? -170 : 0;
    uiText(p, 'Escolha uma cena:', 0, 383, 900, 90, { color: '#323232', size: 0.8 });
    uiText(p, "Prev'quedasRV", 0, -403, 600, 64, { color: '#323232', size: 0.85 });
    uiButton(uiImage(p, img['prev-quarto'], shift - 200, 154, 250, 250, { color: '#dbdbdb' }), function () { goTo(2); });
    uiButton(uiImage(p, img['prev-banheiro'], shift + 200, 154, 250, 250, { color: '#dbdbdb' }), function () { goTo(4); });
    uiButton(uiImage(p, img['risco-quarto'], shift - 200, -173, 250, 250, { color: '#dbdbdb' }), function () { goTo(3); });
    uiButton(uiImage(p, img['risco-banheiro'], shift + 200, -173, 250, 250, { color: '#dbdbdb' }), function () { goTo(5); });
    if (envList.length) {
      var card = document.createElement('a-entity');
      card.setAttribute('geometry', { primitive: 'plane', width: 300 * PX, height: 577 * PX });
      card.setAttribute('material', { color: '#dbdbdb', shader: 'flat' });
      card.setAttribute('position', (450 * PX) + ' ' + (-10 * PX) + ' 0.01');
      p.appendChild(card);
      uiText(card, 'Outros', 0, 60, 280, 60, { color: '#00686a', size: 0.8 });
      uiText(card, 'ambientes', 0, 0, 280, 60, { color: '#00686a', size: 0.8 });
      uiText(card, envList.length + (envList.length === 1 ? ' disponível' : ' disponíveis'), 0, -70, 280, 44, { color: '#323232', size: 0.7, weight: '400' });
      uiButton(card, function () { goTo('lista:0'); });
    }
    play(DATA.ui.menuAudio);
    return Promise.resolve();
  }

  var PER_PAGE = 6;
  function buildList(page) {
    var p = uiPanel('#009293');
    var pages = Math.max(1, Math.ceil(envList.length / PER_PAGE));
    page = Math.max(0, Math.min(pages - 1, page));
    uiText(p, 'Outros ambientes', 0, 383, 900, 90, { color: '#323232', size: 0.8 });
    var items = envList.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
    items.forEach(function (a, i) {
      var col = i % 3, row = Math.floor(i / 3);
      var cols = Math.min(3, items.length - row * 3); // linha incompleta fica centralizada
      // deixa um vao no centro: a mira comeca ali e nao deve abrir nada sozinha
      var x = (col - (cols - 1) / 2) * 420, y = row === 0 ? 172 : -172;
      var card = document.createElement('a-entity');
      card.setAttribute('geometry', { primitive: 'plane', width: 380 * PX, height: 300 * PX });
      card.setAttribute('material', { color: '#dbdbdb', shader: 'flat' });
      card.setAttribute('position', (x * PX) + ' ' + (y * PX) + ' 0.01');
      p.appendChild(card);
      if (a.thumb) uiImage(card, a.thumb + '?v=' + encodeURIComponent(a.updatedAt || ''), 0, 35, 360, 203, { color: '#ffffff', transparent: false });
      else uiText(card, a.type === 'photo' ? '360°' : '3D', 0, 35, 360, 203, { color: '#ffffff', background: '#7fb3b4', size: 0.5 });
      uiText(card, a.name, 0, -110, 360, 56, { color: '#323232', size: 0.62 });
      uiButton(card, function () { goTo('amb:' + a.id); });
    });
    if (page > 0) uiTextButton(p, '‹ Anterior', -560, -403, 260, 70, function () { goTo('lista:' + (page - 1)); });
    if (page < pages - 1) uiTextButton(p, 'Próxima ›', 560, -403, 260, 70, function () { goTo('lista:' + (page + 1)); });
    uiTextButton(p, 'Voltar ao menu', 0, -403, 360, 70, function () { goTo('menu'); });
    return Promise.resolve();
  }

  function buildTutorial() {
    var p = uiPanel('#e9eeee');
    var video = document.getElementById('tutorial-video');
    if (!video) {
      video = document.createElement('video');
      video.id = 'tutorial-video';
      video.src = DATA.ui.video;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      document.body.appendChild(video);
      video.style.display = 'none';
    }
    video.currentTime = 0;
    var screen = document.createElement('a-entity');
    screen.setAttribute('geometry', { primitive: 'plane', width: 960 * PX, height: 540 * PX });
    screen.setAttribute('material', { src: '#tutorial-video', shader: 'flat' });
    screen.setAttribute('position', '0 ' + (32 * PX) + ' 0.01');
    p.appendChild(screen);

    var img = DATA.ui.images;
    var playBtn = uiButton(uiImage(p, img['bt-play'], -435, -284, 92, 92, { color: '#e6e6e6' }), function () {
      if (video.paused) video.play(); else video.pause();
    }, '#e6e6e6');
    uiImage(p, img['barra-video'], 45, -284, 800, 14, { color: '#ffffff' });
    var head = uiImage(p, img['bt-bolinha'], -352, -284, 40, 40, { color: '#ffffff' });
    var time = uiText(p, '00:00 / 00:00', 590, -284, 220, 40, { color: '#323232', size: 0.75 });
    uiTextButton(p, 'Avançar', 0, -372, 328, 80, function () { video.pause(); goTo('menu'); }, '#00868a');

    var fmt = function (s) { s = Math.floor(s || 0); return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2); };
    var update = function () {
      var f = video.duration ? video.currentTime / video.duration : 0;
      head.object3D.position.x = (-352 + f * (442 + 352)) * PX;
      time.setAttribute('canvas-text', 'text', fmt(video.currentTime) + ' / ' + fmt(video.duration));
      playBtn.setAttribute('material', 'src', video.paused ? img['bt-play'] : img['bt-pause']);
    };
    if (!video.dataset.wired) {
      video.dataset.wired = '1';
      ['timeupdate', 'play', 'pause', 'loadedmetadata'].forEach(function (e) { video.addEventListener(e, function () { if (current === 'tutorial') update(); }); });
    }
    return Promise.resolve();
  }

  // ------------------------------------------------------------------ navegacao
  // destinos: 'tutorial' | 'menu' | 'lista:<pagina>' | 'unity:<2..5>' | 'amb:<id>' (numeros 0..5 tambem servem)
  function route(target) {
    if (typeof target === 'number' || /^\d+$/.test(String(target))) {
      var i = Math.max(0, Math.min(5, +target | 0));
      return i === 0 ? 'tutorial' : i === 1 ? 'menu' : 'unity:' + i;
    }
    return String(target);
  }

  function goTo(target) {
    var r = route(target);
    loadToken++;
    stopAudio();
    hidePanel();
    var v = document.getElementById('tutorial-video');
    if (v) v.pause();
    E.clearWorld(world);
    current = r;
    var isRoom = r.indexOf('unity:') === 0 || r.indexOf('amb:') === 0;
    loadingEl.textContent = 'Carregando…';
    loadingEl.hidden = !isRoom;
    recenter.setAttribute('look-down-menu', 'enabled', isRoom);
    var build;
    if (r === 'tutorial') build = buildTutorial;
    else if (r === 'menu') build = function () { return loadEnvList().then(buildMenu); };
    else if (r.indexOf('lista:') === 0) build = function () { return buildList(parseInt(r.slice(6), 10) || 0); };
    else if (r.indexOf('unity:') === 0) build = function () { var o = E.ORIGINALS.find(function (x) { return x.index === +r.slice(6); }); return buildEnv(E.fromUnity(o.key)); };
    else build = function () { return fetchJson('ambientes/' + encodeURIComponent(r.slice(4)) + '/ambiente.json').then(buildEnv); };
    var token = loadToken;
    Promise.resolve(build()).then(function () {
      if (token !== loadToken) return;
      loadingEl.hidden = true;
      recenterView();
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'scene', route: r }));
    }).catch(function (e) {
      console.error(e);
      loadingEl.hidden = false;
      loadingEl.textContent = 'Erro ao carregar: ' + e.message;
    });
  }
  sceneEl.addEventListener('menu-requested', function () { goTo('menu'); });

  // Gira o rig para que a direcao "para frente" da cena fique onde o usuario esta olhando
  function recenterView() {
    var e = new THREE.Euler().setFromQuaternion(cameraEl.object3D.quaternion, 'YXZ');
    recenter.object3D.rotation.set(0, Math.PI - e.y, 0);
  }

  // ------------------------------------------------------------------ entrada
  function setStereo(on) {
    sceneEl.systems['stereo-mode'].setEnabled(on);
    document.getElementById('cardboard-divider').hidden = !on;
    var cur = document.getElementById('cursor');
    // a mira fica a uma distancia confortavel; o raio sempre sai da camera
    var dist = on ? 1.5 : 1.2;
    cur.setAttribute('position', '0 0 ' + (-dist));
    cur.setAttribute('raycaster', 'origin', '0 0 ' + dist);
  }

  function start(mode) {
    document.getElementById('intro').hidden = true;
    document.getElementById('btn-toggle-stereo').hidden = false;
    // gesto do usuario: libera audio, tela cheia e orientacao paisagem
    narration.src = DATA.ui.menuAudio; narration.muted = true;
    var p = narration.play(); if (p && p.then) p.then(function () { narration.pause(); narration.muted = false; }).catch(function () { narration.muted = false; });
    if (mode === 'cardboard') {
      var de = document.documentElement;
      if (de.requestFullscreen && !window.ReactNativeWebView) {
        de.requestFullscreen().then(function () {
          if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
        }).catch(function () {});
      }
    }
    setStereo(mode === 'cardboard');
    if (params.has('amb')) goTo('amb:' + params.get('amb'));
    else goTo(params.has('cena') ? parseInt(params.get('cena'), 10) : 0);
  }

  document.getElementById('btn-cardboard').addEventListener('click', function () { start('cardboard'); });
  document.getElementById('btn-magic').addEventListener('click', function () { start('magic'); });
  document.getElementById('btn-toggle-stereo').addEventListener('click', function (e) {
    e.stopPropagation();
    setStereo(!sceneEl.systems['stereo-mode'].data.enabled);
  });

  // API para o app nativo (React Native) e para testes
  function look(yawDeg, pitchDeg) {
    var lc = cameraEl.components['look-controls'];
    lc.yawObject.rotation.y = THREE.MathUtils.degToRad(yawDeg || 0);
    lc.pitchObject.rotation.x = THREE.MathUtils.degToRad(pitchDeg || 0);
  }
  window.PrevQuedas = {
    goTo: goTo, setStereo: setStereo, recenter: recenterView, look: look,
    current: function () { return current; },
    nowPlaying: function () { return narration.paused ? null : narration.src; },
    panel: function () { return panel ? panel.getAttribute('text-panel') : null; }
  };

  function boot() {
    var modo = params.get('modo');
    if (modo === 'cardboard' || modo === 'magic') start(modo);
  }
  if (sceneEl.hasLoaded) boot(); else sceneEl.addEventListener('loaded', boot);
})();
