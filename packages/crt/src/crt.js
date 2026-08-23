// WebGL2 CRT presentation pipeline.
//
//   source (R8 beam intensity, grid + margin, NEAREST)
//     -> beam pass      spot convolution + luma-widened scanlines, blended with
//                       the previous frame for persistence (ping-pong)
//     -> bloom pass     threshold + separable blur at quarter res
//     -> composite      barrel warp, aperture mask, tint, vignette, noise,
//                       flicker, rolling bar, glass
//
// Everything upstream of the composite is monochrome beam intensity; colour is
// applied in the last pass only.
//
// Uniform values come from ../config.js. The constructor also takes an override
// object, so the module works without it.

import { SCREEN, PHOSPHORS, PHOSPHOR } from '../config.js'
import { VERT, SPOT_H, BEAM, BLUR, COMPOSITE } from './shaders.js'

export class CRT {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} srcW framebuffer width, from Term.w
   * @param {number} srcH framebuffer height, from Term.h
   * @param {number} superSample beam and persistence buffer size as a multiple
   *   of the source
   * @param {object} [params] uniform overrides on top of SCREEN
   */
  constructor(canvas, srcW, srcH, superSample = 2, params = null) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL2 is required')

    this.gl = gl
    this.canvas = canvas
    this.srcW = srcW
    this.srcH = srcH
    this.superSample = superSample
    this.cw = srcW * superSample
    this.ch = srcH * superSample
    this.params = { ...SCREEN, ...(params ?? {}) }
    this.phosphor = PHOSPHORS[PHOSPHOR]
    this.dpr = 1

    // Every GL object created, so dispose() can free them.
    this.textures = []
    this.framebuffers = []
    this.programs = []
    this.disposed = false
    this.flip = 0

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    this.vao = gl.createVertexArray()

    this.progSpot = this.program(VERT, SPOT_H)
    this.progBeam = this.program(VERT, BEAM)
    this.progBlur = this.program(VERT, BLUR)
    this.progComp = this.program(VERT, COMPOSITE)

    this.build()
  }

  /** Set the beam tint by name. See PHOSPHORS in config.js. */
  setPhosphor(name) {
    const tint = PHOSPHORS[name]
    if (tint) this.phosphor = tint
  }

  /** Overlay uniform values onto the current tuning. See PRESETS in config.js. */
  setParams(params) {
    Object.assign(this.params, params)
  }

  /** Allocate the buffers sized from the source. */
  build() {
    const gl = this.gl
    this.src = this.texture(this.srcW, this.srcH, gl.NEAREST)
    this.spot = this.target(this.srcW, this.srcH)
    this.persist = [this.target(this.cw, this.ch), this.target(this.cw, this.ch)]
    this.bloom = [
      this.target(this.cw >> 2, this.ch >> 2),
      this.target(this.cw >> 2, this.ch >> 2),
    ]
    this.clearPersist()
  }

  /**
   * Re-point the chain at a differently sized source. Every buffer upstream of
   * the composite is sized from the framebuffer, so all of them are rebuilt.
   *
   * Programs, uniforms, params and phosphor survive; the persistence buffer does
   * not, so the output is dark for one frame.
   */
  setSource(srcW, srcH) {
    if (this.disposed || (srcW === this.srcW && srcH === this.srcH)) return
    this.dropTexture(this.src)
    for (const t of [this.spot, ...this.persist, ...this.bloom]) this.dropTarget(t)

    this.srcW = srcW
    this.srcH = srcH
    this.cw = srcW * this.superSample
    this.ch = srcH * this.superSample
    this.build()
  }

  /** Clear the persistence buffers, so frame 0 is not garbage. */
  clearPersist() {
    const gl = this.gl
    for (const t of this.persist) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // Free, then untrack. A freed handle left in the arrays would be deleted
  // twice by dispose().
  dropTexture(tex) {
    this.gl.deleteTexture(tex)
    const i = this.textures.indexOf(tex)
    if (i >= 0) this.textures.splice(i, 1)
  }

  dropTarget(t) {
    this.gl.deleteFramebuffer(t.fbo)
    const i = this.framebuffers.indexOf(t.fbo)
    if (i >= 0) this.framebuffers.splice(i, 1)
    this.dropTexture(t.tex)
  }

  program(vsSrc, fsSrc) {
    const gl = this.gl
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) + '\n' + src)
      }
      return s
    }
    const p = gl.createProgram()
    const vs = compile(gl.VERTEX_SHADER, vsSrc)
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc)
    gl.attachShader(p, vs)
    gl.attachShader(p, fs)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) ?? 'link failed')
    }
    // Linked into the program; the shader objects leak until deleted.
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    // Cache uniform locations by name.
    p.u = {}
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name
      p.u[name] = gl.getUniformLocation(p, name)
    }
    this.programs.push(p)
    return p
  }

  texture(w, h, filter) {
    const gl = this.gl
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.textures.push(t)
    return t
  }

  target(w, h) {
    const gl = this.gl
    const tex = this.texture(w, h, gl.LINEAR)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    this.framebuffers.push(fbo)
    return { tex, fbo, w, h }
  }

  /** Upload one frame of beam bytes. `fb` is Term.fb. */
  upload(fb) {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.src)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.srcW, this.srcH,
                     gl.RED, gl.UNSIGNED_BYTE, fb)
  }

  /**
   * Match the drawing buffer to the canvas box, capped at `budget` pixels.
   *
   * The composite is the only pass that scales with the canvas size. Measured
   * off the canvas box, not the window. No feedback loop: the CSS size is a
   * percentage, so writing canvas.width cannot move clientWidth.
   */
  resize(budget = 2.6e6) {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    // An unlaid-out canvas answers 0, and a zero-sized drawing buffer is a GL
    // error.
    const cw = this.canvas.clientWidth || innerWidth
    const ch = this.canvas.clientHeight || innerHeight
    const scale = Math.min(1, Math.sqrt(budget / (cw * ch * dpr * dpr)))
    const w = Math.round(cw * dpr * scale)
    const h = Math.round(ch * dpr * scale)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.dpr = dpr * scale
  }

  bind(target) {
    const gl = this.gl
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      gl.viewport(0, 0, target.w, target.h)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3) }

  unit(prog, name, tex, slot) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + slot)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(prog.u[name], slot)
  }

  /** @param {number} time seconds since start. */
  render(time) {
    if (this.disposed) return
    const gl = this.gl
    const P = this.params
    gl.bindVertexArray(this.vao)

    // --- horizontal spot convolution, at source resolution ---
    gl.useProgram(this.progSpot)
    this.bind(this.spot)
    this.unit(this.progSpot, 'uSrc', this.src, 0)
    gl.uniform2f(this.progSpot.u.uOutSize, this.srcW, this.srcH)
    gl.uniform1f(this.progSpot.u.uBeam, P.beam)
    gl.uniform1f(this.progSpot.u.uSharpen, P.sharpen)
    this.draw()

    // --- scanline profile + persistence ---
    const prev = this.persist[this.flip]
    const next = this.persist[this.flip ^ 1]
    this.flip ^= 1

    gl.useProgram(this.progBeam)
    this.bind(next)
    this.unit(this.progBeam, 'uSrc', this.spot.tex, 0)
    this.unit(this.progBeam, 'uPrev', prev.tex, 1)
    gl.uniform2f(this.progBeam.u.uSrcSize, this.srcW, this.srcH)
    gl.uniform2f(this.progBeam.u.uOutSize, next.w, next.h)
    gl.uniform1f(this.progBeam.u.uDecay, P.decay)
    gl.uniform1f(this.progBeam.u.uScanMin, P.scanMin)
    gl.uniform1f(this.progBeam.u.uScanMax, P.scanMax)
    this.draw()

    // --- bloom ---
    gl.useProgram(this.progBlur)
    this.bind(this.bloom[0])
    this.unit(this.progBlur, 'uTex', next.tex, 0)
    gl.uniform2f(this.progBlur.u.uOutSize, this.bloom[0].w, this.bloom[0].h)
    gl.uniform2f(this.progBlur.u.uDir, 1, 0)
    gl.uniform1f(this.progBlur.u.uThreshold, P.threshold)
    this.draw()

    this.bind(this.bloom[1])
    this.unit(this.progBlur, 'uTex', this.bloom[0].tex, 0)
    gl.uniform2f(this.progBlur.u.uOutSize, this.bloom[1].w, this.bloom[1].h)
    gl.uniform2f(this.progBlur.u.uDir, 0, 1)
    gl.uniform1f(this.progBlur.u.uThreshold, 0)
    this.draw()

    // --- composite ---
    gl.useProgram(this.progComp)
    this.bind(null)
    this.unit(this.progComp, 'uScreen', next.tex, 0)
    this.unit(this.progComp, 'uBloom', this.bloom[1].tex, 1)
    const u = this.progComp.u
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height)
    gl.uniform1f(u.uTime, time)
    gl.uniform3fv(u.uPhosphor, this.phosphor)
    gl.uniform1f(u.uFill, P.fill)
    gl.uniform1f(u.uCurve, P.curve)
    gl.uniform1f(u.uBloomAmt, P.bloomAmt)
    gl.uniform1f(u.uMaskAmt, P.maskAmt)
    gl.uniform1f(u.uMaskPitch, P.maskPitch * (this.dpr || 1))
    gl.uniform1f(u.uVignette, P.vignette)
    gl.uniform1f(u.uNoise, P.noise)
    // In device pixels, so the streak is the same physical size at any
    // composite resolution.
    gl.uniform1f(u.uNoiseStreak, P.noiseStreak * (this.dpr || 1))
    gl.uniform1f(u.uSnow, P.snow)
    gl.uniform1f(u.uFlicker, P.flicker)
    gl.uniform1f(u.uRoll, P.roll)
    gl.uniform1f(u.uRollSpeed, P.rollSpeed)
    gl.uniform1f(u.uChroma, P.chroma)
    gl.uniform1f(u.uBrightness, P.brightness)
    gl.uniform1f(u.uAmbient, P.ambient)
    gl.uniform1f(u.uBg, P.bg)
    gl.uniform1f(u.uGlass, P.glass)
    this.draw()
  }

  // Browsers cap live WebGL contexts (~16) and drop the oldest past that, so
  // repeated mounts would kill other canvases on the page.
  dispose() {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    for (const p of this.programs) gl.deleteProgram(p)
    for (const t of this.textures) gl.deleteTexture(t)
    for (const f of this.framebuffers) gl.deleteFramebuffer(f)
    gl.deleteVertexArray(this.vao)
    this.programs = []
    this.textures = []
    this.framebuffers = []
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
