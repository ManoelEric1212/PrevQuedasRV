/*
 * Modo Cardboard proprio (tela dividida), sem depender de WebXR.
 * Funciona no Chrome do Android e dentro de um WebView (app React Native),
 * onde WebXR nao existe. A orientacao da cabeca vem do look-controls
 * (DeviceOrientation / "magic window").
 *
 * Cada olho e renderizado com o centro da imagem alinhado ao centro da lente
 * (e nao ao centro da metade da tela) e depois passa por uma distorcao "barril"
 * que compensa a lente. Sem isso as imagens ficam afastadas demais e a pessoa
 * fica "vesga" tentando junta-las.
 *
 * Geometria igual a do polyfill Cardboard do A-Frame 1.4.1 (cardboard-vr-display):
 * o centro de cada lente fica na altura real da lente (35 mm da base do visor,
 * menos a borda do celular), e nao no meio da tela.
 *
 * Parametros padrao: Google Cardboard v2. Podem ser ajustados por URL, ex.:
 *   ?visor=v1    perfil Cardboard 2014 (v1) ou 2015 (v2, padrao)
 *   ?lentes=60   distancia entre os centros das lentes em mm
 *   ?base=35     distancia da base do visor ate o centro das lentes em mm
 *   ?borda=4     borda do celular abaixo da tela em mm
 *   ?dpi=160     densidade da tela (px CSS por polegada; Android ~160, iPhone ~163)
 *   ?centro=1    volta a centralizar as lentes na altura da tela (comportamento antigo)
 */
/* global AFRAME, THREE */
AFRAME.registerSystem('stereo-mode', {
  schema: {
    enabled: { default: false },
    eyeSeparation: { default: 0.064 },     // distancia entre as cameras (m)
    interLensDistance: { default: 0.064 }, // distancia entre os centros das lentes (m)
    screenLensDistance: { default: 0.039 },// tela -> lente (m)
    baselineLensDistance: { default: 0.035 }, // base do visor -> centro das lentes (m)
    bevel: { default: 0.004 },             // borda do celular abaixo da tela (m)
    centerVertically: { default: false },  // true = lentes no meio da altura da tela
    k1: { default: 0.34 },                 // coeficientes de distorcao da lente
    k2: { default: 0.55 },
    maxFov: { default: 60 },               // meio-angulo maximo visivel pela lente (graus)
    cssPxPerInch: { default: 160 }
  },

  init: function () {
    var p = new URLSearchParams(location.search);
    if (p.get('visor') === 'v1') { // Cardboard I/O 2014
      Object.assign(this.data, { interLensDistance: 0.060, screenLensDistance: 0.042, k1: 0.441, k2: 0.156, maxFov: 40 });
    }
    var mm = function (k, fallback) { var v = parseFloat(p.get(k)); return (isNaN(v) ? fallback : v) / 1000; };
    if (p.has('base')) this.data.baselineLensDistance = mm('base', 35);
    if (p.has('borda')) this.data.bevel = mm('borda', 4);
    if (p.get('centro') === '1') this.data.centerVertically = true;
    if (p.has('lentes')) this.data.interLensDistance = (parseFloat(p.get('lentes')) || 64) / 1000;
    if (p.has('dpi')) this.data.cssPxPerInch = parseFloat(p.get('dpi')) || 160;

    this.eyeL = new THREE.PerspectiveCamera();
    this.eyeR = new THREE.PerspectiveCamera();
    [this.eyeL, this.eyeR].forEach(function (c) { c.matrixAutoUpdate = false; c.matrixWorldAutoUpdate = false; });
    this.offset = new THREE.Matrix4();
    this.buf = new THREE.Vector2();
    this.rtL = this.rtR = null;

    // passo final: desenha as duas imagens distorcidas na tela
    this.uniforms = {
      uL: { value: null }, uR: { value: null },
      uHalf: { value: 0 }, uMpp: { value: 0 }, uSld: { value: 0 },
      uCL: { value: new THREE.Vector2() }, uCR: { value: new THREE.Vector2() },
      uK: { value: new THREE.Vector2() },
      uFL: { value: new THREE.Vector4() }, uFR: { value: new THREE.Vector4() }
    };
    var mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false, depthWrite: false,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D uL; uniform sampler2D uR;',
        'uniform float uHalf; uniform float uMpp; uniform float uSld;',
        'uniform vec2 uCL; uniform vec2 uCR; uniform vec2 uK;',
        'uniform vec4 uFL; uniform vec4 uFR;', // (esq, dir, baixo, cima) em tangente
        'void main(){',
        '  vec2 p = gl_FragCoord.xy;',
        '  bool r = p.x >= uHalf;',
        '  vec2 t = (p - (r ? uCR : uCL)) * uMpp / uSld;',
        '  float r2 = dot(t, t);',
        '  vec2 e = t * (1.0 + uK.x * r2 + uK.y * r2 * r2);',
        '  vec4 f = r ? uFR : uFL;',
        '  vec2 uv = vec2((e.x - f.x) / (f.y - f.x), (e.y - f.z) / (f.w - f.z));',
        '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }',
        '  else { gl_FragColor = r ? texture2D(uR, uv) : texture2D(uL, uv); }',
        '  #include <colorspace_fragment>',
        '}'
      ].join('\n')
    });
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    var sceneEl = this.el;
    var self = this;
    var patch = function () {
      var renderer = sceneEl.renderer;
      var original = renderer.render.bind(renderer);
      renderer.render = function (scene, camera) {
        if (!self.data.enabled || renderer.xr.isPresenting || renderer.getRenderTarget()) {
          return original(scene, camera);
        }
        self.renderStereo(renderer, original, scene, camera);
      };
    };
    if (sceneEl.renderer) patch(); else sceneEl.addEventListener('renderstart', patch);
  },

  ensureTargets: function (w, h) {
    if (this.rtL && this.rtL.width === w && this.rtL.height === h) return;
    if (this.rtL) { this.rtL.dispose(); this.rtR.dispose(); }
    var opts = { samples: 4, colorSpace: THREE.SRGBColorSpace };
    this.rtL = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtR = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtL.texture.colorSpace = this.rtR.texture.colorSpace = THREE.SRGBColorSpace;
  },

  renderStereo: function (renderer, original, scene, camera) {
    var d = this.data, u = this.uniforms;
    renderer.getDrawingBufferSize(this.buf);
    var W = this.buf.x, H = this.buf.y, half = W / 2;
    var cssW = renderer.domElement.clientWidth || W;
    // metros por pixel do drawing buffer
    var mpp = (0.0254 / d.cssPxPerInch) * cssW / W;
    var lensOff = (d.interLensDistance / 2) / mpp;
    // altura do centro das lentes, medida a partir da base da tela (gl_FragCoord.y = 0 embaixo)
    var cy = d.centerVertically ? H / 2
      : THREE.MathUtils.clamp((d.baselineLensDistance - d.bevel) / mpp, 0, H);
    var cL = new THREE.Vector2(half - lensOff, cy);
    var cR = new THREE.Vector2(half + lensOff, cy);

    // limites (em tangente vista pelo olho) da regiao de cada olho na tela
    var k1 = d.k1, k2 = d.k2, sld = d.screenLensDistance, tmax = Math.tan(THREE.MathUtils.degToRad(d.maxFov));
    var dist = function (x, y) { var r2 = x * x + y * y; return 1 + k1 * r2 + k2 * r2 * r2; };
    var bounds = function (x0, x1, c) {
      var l = (x0 - c.x) * mpp / sld, r = (x1 - c.x) * mpp / sld;
      var b = -cy * mpp / sld, t = (H - cy) * mpp / sld;
      var xm = Math.max(-l, r), ym = Math.max(-b, t); // cantos mais distantes (onde a distorcao e maior)
      return new THREE.Vector4(
        Math.max(l * dist(l, ym), -tmax), Math.min(r * dist(r, ym), tmax),
        Math.max(b * dist(xm, b), -tmax), Math.min(t * dist(xm, t), tmax));
    };
    var fL = bounds(0, half, cL), fR = bounds(half, W, cR);

    // resolucao de cada olho ~ pixels da metade da tela
    var ew = Math.min(2048, Math.round(half * 1.25)), eh = Math.min(2048, Math.round(H * 1.25));
    this.ensureTargets(ew, eh);

    camera.updateWorldMatrix(true, false);
    var near = camera.near, far = camera.far;
    var renderEye = function (eye, f, sign, rt, self) {
      eye.projectionMatrix.makePerspective(f.x * near, f.y * near, f.w * near, f.z * near, near, far);
      eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
      self.offset.makeTranslation(sign * d.eyeSeparation / 2, 0, 0);
      eye.matrixWorld.copy(camera.matrixWorld).multiply(self.offset);
      eye.matrix.copy(eye.matrixWorld);
      eye.matrixWorldInverse.copy(eye.matrixWorld).invert();
      eye.layers.mask = camera.layers.mask;
      renderer.setRenderTarget(rt);
      original(scene, eye);
    };
    renderEye(this.eyeL, fL, -1, this.rtL, this);
    renderEye(this.eyeR, fR, 1, this.rtR, this);
    renderer.setRenderTarget(null);

    u.uL.value = this.rtL.texture; u.uR.value = this.rtR.texture;
    u.uHalf.value = half; u.uMpp.value = mpp; u.uSld.value = sld;
    u.uCL.value.copy(cL); u.uCR.value.copy(cR);
    u.uK.value.set(k1, k2);
    u.uFL.value.copy(fL); u.uFR.value.copy(fR);
    original(this.quadScene, this.quadCam);
  },

  setEnabled: function (on) {
    this.data.enabled = !!on;
    this.el.emit('stereochange', { enabled: this.data.enabled });
  }
});
