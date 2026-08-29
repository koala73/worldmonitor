import * as Cesium from 'cesium';
import { holdContinuousRender, releaseContinuousRender } from './renderGovernor.js';

/**
 * OrbitController — smooth orbit around a target point.
 * Uses scene.preRender for frame-rate-independent 60fps updates.
 * Toggle with O key; auto-stops on POI/city change.
 */
export class OrbitController {
  constructor(viewer) {
    this.viewer = viewer;
    this.active = false;
    this.target = null;
    this.radius = 500;
    this.pitch = -30;
    this.speed = Cesium.Math.toRadians(6); // ~6°/sec → full rotation in ~60s
    this.angle = 0;
    this._removeListener = null;
  }

  /**
   * Start orbiting around a target position.
   * @param {Cesium.Cartesian3} targetCartesian - The point to orbit around
   * @param {object} options
   * @param {number} options.radius - Distance from target in meters
   * @param {number} options.pitch - Tilt angle in degrees (negative = looking down)
   * @param {number} options.speed - Degrees per second (default 6)
   */
  start(targetCartesian, options = {}) {
    if (!targetCartesian) return;

    this.target = targetCartesian;
    this.radius = options.radius || this.radius;
    this.pitch = options.pitch || this.pitch;
    this.speed = Cesium.Math.toRadians(options.speed || 6);
    this.active = true;
    // Orbit mutates the camera from preRender — without a hold the loop
    // starves after its first idle frame. (perf wave 2)
    holdContinuousRender('camera-orbit');

    // Start from the camera's current heading for seamless transition
    this.angle = this.viewer.camera.heading;

    let lastTime = Date.now();
    this._removeListener = this.viewer.scene.preRender.addEventListener(() => {
      if (!this.active) return;

      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      this.angle += this.speed * dt;

      const hpr = new Cesium.HeadingPitchRange(
        this.angle,
        Cesium.Math.toRadians(this.pitch),
        this.radius
      );
      this.viewer.camera.lookAt(this.target, hpr);
    });
  }

  /**
   * Stop orbiting. Camera freezes at current position and user regains control.
   */
  stop() {
    this.active = false;
    releaseContinuousRender('camera-orbit');
    if (this._removeListener) {
      this._removeListener();
      this._removeListener = null;
    }
    // Unlock camera for free interaction
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  /**
   * Toggle orbit on/off.
   * @param {Cesium.Cartesian3} targetCartesian - Required when starting
   * @param {object} options - Passed to start()
   * @returns {boolean} Whether orbit is now active
   */
  toggle(targetCartesian, options) {
    if (this.active) {
      this.stop();
    } else {
      this.start(targetCartesian, options);
    }
    return this.active;
  }
}
