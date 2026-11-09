/* global AFRAME, THREE */

/* Texto desenhado num canvas (suporta acentos, funciona offline, sem fontes MSDF). */
AFRAME.registerComponent('canvas-text', {
  schema: {
    text: { type: 'string' },
    width: { default: 1 },      // metros
    height: { default: 0.25 },  // metros
    size: { default: 0.6 },     // fracao da altura
    color: { default: '#323232' },
    background: { default: '' },
    radius: { default: 0 },     // fracao da altura (cantos arredondados)
    weight: { default: '700' },
    align: { default: 'center' }
  },
  init: function () {
    this.canvas = document.createElement('canvas');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.el.setObject3D('mesh', this.mesh);
  },
  update: function () {
    var d = this.data;
    var pxPerM = 512;
    var w = this.canvas.width = Math.max(4, Math.round(d.width * pxPerM));
    var h = this.canvas.height = Math.max(4, Math.round(d.height * pxPerM));
    var ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (d.background) {
      ctx.fillStyle = d.background;
      var r = d.radius * h;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0, 0, w, h, r); else ctx.rect(0, 0, w, h);
      ctx.fill();
    }
    ctx.fillStyle = d.color;
    // diminui a fonte ate o texto caber na largura
    var px = Math.round(h * d.size);
    var font = function () { return d.weight + ' ' + px + 'px system-ui, Roboto, "Segoe UI", sans-serif'; };
    ctx.font = font();
    while (px > 8 && ctx.measureText(d.text).width > w * 0.94) { px -= 2; ctx.font = font(); }
    ctx.textBaseline = 'middle';
    ctx.textAlign = d.align;
    var x = d.align === 'left' ? 0 : d.align === 'right' ? w : w / 2;
    ctx.fillText(d.text, x, h / 2);
    this.texture.needsUpdate = true;
    this.mesh.scale.set(d.width, d.height, 1);
  },
  remove: function () {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.el.removeObject3D('mesh');
  }
});

/* Anel de progresso do "olhar fixo" (fuse) em volta da mira. */
AFRAME.registerComponent('fuse-ring', {
  init: function () {
    var el = this.el;
    var ring = this.ring = document.createElement('a-entity');
    ring.setAttribute('geometry', 'primitive: ring; radiusInner: 0.022; radiusOuter: 0.032; thetaLength: 0; thetaStart: 90');
    ring.setAttribute('material', 'color: #00c2c4; shader: flat; depthTest: false; transparent: true');
    ring.setAttribute('scale', '-1 1 1'); // cresce no sentido horario
    el.appendChild(ring);
    var dur = el.getAttribute('cursor').fuseTimeout;
    var start = null;
    var self = this;
    this.tick = function (t) {
      if (start === null) return;
      var p = Math.min(1, (t - start) / dur);
      ring.setAttribute('geometry', 'thetaLength', Math.max(0.01, p * 360));
    };
    el.addEventListener('fusing', function () { start = self.el.sceneEl.time; el.setAttribute('scale', '1.4 1.4 1.4'); });
    var reset = function () { start = null; ring.setAttribute('geometry', 'thetaLength', 0.01); el.setAttribute('scale', '1 1 1'); };
    el.addEventListener('mouseleave', reset);
    el.addEventListener('click', reset);
  }
});

/*
 * Objeto interativo: destaque ao olhar (troca de material, como no Unity)
 * e acao ao clicar/fixar o olhar. O alvo do raio e a caixa do BoxCollider.
 */
AFRAME.registerComponent('interactive', {
  schema: {
    target: { type: 'selector' }, // entidade com a malha a destacar
    marker: { default: false }    // sinal (sprite): destaque = aumentar
  },
  init: function () {
    var self = this;
    this.el.addEventListener('mouseenter', function () { self.highlight(true); });
    this.el.addEventListener('mouseleave', function () { self.highlight(false); });
  },
  highlight: function (on) {
    var target = this.data.target || this.el;
    if (this.data.marker) {
      var m = target.getObject3D('mesh');
      if (m) { m.userData.baseScale = m.userData.baseScale || m.scale.x; m.scale.setScalar(m.userData.baseScale * (on ? 1.3 : 1)); }
      return;
    }
    var hover = this.el.userDataHover;
    target.object3D.traverse(function (o) {
      if (!o.isMesh || o.userData.isHitBox) return;
      if (hover) {
        if (on) { o.userData.baseMaterial = o.userData.baseMaterial || o.material; o.material = hover; }
        else if (o.userData.baseMaterial) o.material = o.userData.baseMaterial;
      } else if (o.material && o.material.emissive) {
        o.material.emissive.setHex(on ? 0x335555 : 0x000000);
      }
    });
  }
});

/* Mantem a entidade sempre virada para a camera (rotacao so em Y). */
AFRAME.registerComponent('look-at-camera', {
  schema: { yOnly: { default: true } },
  tick: function () {
    var cam = this.el.sceneEl.camera;
    if (!cam) return;
    var p = new THREE.Vector3();
    cam.getWorldPosition(p);
    var o = this.el.object3D;
    if (!this.data.yOnly) { o.lookAt(p); return; }
    var w = new THREE.Vector3();
    o.getWorldPosition(w);
    o.parent.updateMatrixWorld();
    var ang = Math.atan2(p.x - w.x, p.z - w.z);
    var pq = new THREE.Quaternion();
    o.parent.getWorldQuaternion(pq);
    o.quaternion.setFromEuler(new THREE.Euler(0, ang, 0)).premultiply(pq.invert());
  }
});

/* Placa de texto com titulo e paragrafo (quebra de linha automatica). */
AFRAME.registerComponent('text-panel', {
  schema: {
    title: { type: 'string' },
    text: { type: 'string' },
    accent: { default: '#00868a' },
    width: { default: 0.9 } // metros
  },
  init: function () {
    this.canvas = document.createElement('canvas');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthTest: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = 20;
    this.el.setObject3D('mesh', this.mesh);
  },
  update: function () {
    var d = this.data;
    var W = 900, pad = 44, titleSize = 52, bodySize = 40, lineH = 54;
    var ctx = this.canvas.getContext('2d');
    var font = 'system-ui, Roboto, "Segoe UI", sans-serif';
    ctx.font = '400 ' + bodySize + 'px ' + font;
    var lines = [];
    String(d.text || '').split(/\n/).forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean), line = '';
      if (!words.length) { lines.push(''); return; }
      words.forEach(function (w) {
        var t = line ? line + ' ' + w : w;
        if (ctx.measureText(t).width > W - pad * 2 && line) { lines.push(line); line = w; } else line = t;
      });
      lines.push(line);
    });
    if (lines.length > 14) { lines = lines.slice(0, 14); lines[13] += '…'; }
    var hasTitle = !!d.title;
    var H = pad * 2 + (hasTitle ? titleSize + 18 : 0) + lines.length * lineH - (lines.length ? lineH - bodySize : 0);
    this.canvas.width = W; this.canvas.height = Math.max(H, 120);
    ctx = this.canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, W, this.canvas.height, 28); else ctx.rect(0, 0, W, this.canvas.height);
    ctx.fill();
    ctx.fillStyle = d.accent;
    ctx.fillRect(0, 0, 14, this.canvas.height);
    var y = pad;
    ctx.textBaseline = 'top';
    if (hasTitle) {
      ctx.fillStyle = d.accent; ctx.font = '700 ' + titleSize + 'px ' + font;
      ctx.fillText(d.title, pad, y, W - pad * 2);
      y += titleSize + 18;
    }
    ctx.fillStyle = '#2a2a2a'; ctx.font = '400 ' + bodySize + 'px ' + font;
    lines.forEach(function (l) { ctx.fillText(l, pad, y); y += lineH; });
    this.texture.needsUpdate = true;
    this.mesh.scale.set(d.width, d.width * this.canvas.height / W, 1);
  },
  remove: function () {
    this.texture.dispose(); this.material.dispose(); this.mesh.geometry.dispose();
    this.el.removeObject3D('mesh');
  }
});

/*
 * Botao "Menu" que aparece quando a pessoa olha para baixo (fica no #recenter, irmao da camera).
 * Ao ser selecionado emite 'menu-requested' na cena.
 */
AFRAME.registerComponent('look-down-menu', {
  // so aparece olhando quase para os pes: objetos no chao (tapete, fios) ficam entre -40 e -65 graus
  schema: { enabled: { default: false }, pitch: { default: -70 } },
  init: function () {
    var b = this.button = document.createElement('a-entity');
    b.setAttribute('canvas-text', { text: '⌂  Menu', width: 0.36, height: 0.13, size: 0.55, color: '#ffffff', background: '#00868a', radius: 0.5 });
    b.object3D.visible = false;
    this.el.appendChild(b);
    var self = this;
    b.addEventListener('mouseenter', function () { b.object3D.scale.setScalar(1.12); });
    b.addEventListener('mouseleave', function () { b.object3D.scale.setScalar(1); });
    b.addEventListener('click', function () { if (self.shown) self.el.sceneEl.emit('menu-requested'); });
    this.shown = false;
  },
  setShown: function (on) {
    if (on === this.shown) return;
    this.shown = on;
    this.button.object3D.visible = on;
    if (on) this.button.classList.add('clickable'); else this.button.classList.remove('clickable');
    var cur = document.getElementById('cursor');
    if (cur && cur.components.raycaster) cur.components.raycaster.refreshObjects();
  },
  tick: function () {
    var cam = document.getElementById('camera');
    if (!cam) return;
    var e = new THREE.Euler().setFromQuaternion(cam.object3D.quaternion, 'YXZ');
    var pitch = THREE.MathUtils.radToDeg(e.x);
    var show = this.data.enabled && pitch < this.data.pitch;
    this.setShown(show);
    if (!show) return;
    // fica abaixo e a frente, na direcao em que a pessoa esta virada
    var yaw = e.y;
    var o = this.button.object3D;
    o.position.set(-Math.sin(yaw) * 0.22, -0.9, -Math.cos(yaw) * 0.22); // ~76 graus abaixo do horizonte
    o.lookAt(this.el.object3D.localToWorld(new THREE.Vector3(0, 0, 0)));
  }
});
