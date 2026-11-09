/*
 * Modo Cardboard proprio (tela dividida), sem depender de WebXR.
 * Funciona no Chrome do Android e dentro de um WebView (app React Native),
 * onde WebXR nao existe. A orientacao da cabeca vem do look-controls
 * (DeviceOrientation / "magic window").
 */
/* global AFRAME, THREE */
AFRAME.registerSystem('stereo-mode', {
  schema: {
    enabled: { default: false },
    eyeSeparation: { default: 0.064 }
  },

  init: function () {
    this.stereo = new THREE.StereoCamera();
    this.stereo.aspect = 0.5; // cada olho ocupa meia tela
    this.size = new THREE.Vector2();
    var sceneEl = this.el;
    var self = this;
    var patch = function () {
      var renderer = sceneEl.renderer;
      var original = renderer.render.bind(renderer);
      renderer.render = function (scene, camera) {
        if (!self.data.enabled || renderer.xr.isPresenting || renderer.getRenderTarget()) {
          return original(scene, camera);
        }
        self.stereo.eyeSep = self.data.eyeSeparation;
        if (camera.parent === null) camera.updateMatrixWorld();
        self.stereo.update(camera);
        renderer.getSize(self.size);
        var w = self.size.x, h = self.size.y, half = w / 2;
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, half, h);
        renderer.setViewport(0, 0, half, h);
        original(scene, self.stereo.cameraL);
        renderer.setScissor(half, 0, half, h);
        renderer.setViewport(half, 0, half, h);
        original(scene, self.stereo.cameraR);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
      };
    };
    if (sceneEl.renderer) patch(); else sceneEl.addEventListener('renderstart', patch);
  },

  setEnabled: function (on) {
    this.data.enabled = !!on;
    this.el.emit('stereochange', { enabled: this.data.enabled });
  }
});
