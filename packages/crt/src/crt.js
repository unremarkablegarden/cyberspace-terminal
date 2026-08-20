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

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// The spot convolution is separable. Running the horizontal half at source
// resolution costs 3 texture fetches per output pixel instead of 21. Do not
// inline it into the beam pass.
const SPOT_H = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uOutSize;
uniform float uBeam;
uniform float uSharpen;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  // Two Gaussians over the same seven taps: the beam spot, and one twice as
  // wide. Their difference is an unsharp mask; subtracting it puts an overshoot
  // either side of every vertical edge, as a video amplifier's peaking stage
  // did. Horizontal only: the scan geometry fixes the vertical direction.
  //
  // Each Gaussian is normalised separately. The summed weights of a difference
  // of Gaussians pass through zero, so one divisor blows up at moderate
  // uSharpen; normalising separately holds DC at unity.
  float accN = 0.0, wsumN = 0.0;
  float accW = 0.0, wsumW = 0.0;
  float s2 = uBeam * uBeam;
  for (int i = -3; i <= 3; i++) {
    float fi = float(i);
    float d = fi * fi;
    float wn = exp(-0.5 * d / s2);
    float ww = exp(-0.5 * d / (s2 * 4.0));
    float t = texture(uSrc, uv + vec2(fi / uOutSize.x, 0.0)).r;
    accN += t * wn; wsumN += wn;
    accW += t * ww; wsumW += ww;
  }
  float narrow = accN / wsumN;
  // Undershoot goes negative and clamps to 0 in the R8 target; overshoot clamps
  // at full drive.
  fragColor = vec4(narrow + uSharpen * (narrow - accW / wsumW), 0.0, 0.0, 1.0);
}`

const BEAM = `#version 300 es
precision highp float;
uniform sampler2D uSrc;   // horizontally convolved, source resolution
uniform sampler2D uPrev;
uniform vec2 uSrcSize;
uniform vec2 uOutSize;
uniform float uDecay;
uniform float uScanMin;
uniform float uScanMax;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  // Grid row 0 is the top line; GL texture v=0 is the bottom row.
  vec2 sp = vec2(uv.x, 1.0 - uv.y) * uSrcSize;
  float rowF = sp.y - 0.5;
  float base = floor(rowF);

  float total = 0.0;
  for (int r = -1; r <= 1; r++) {
    float row = base + float(r);
    // Sampling at the texel centre gives LINEAR horizontal interpolation and no
    // vertical bleed.
    float lum = texture(uSrc, vec2(sp.x / uSrcSize.x, (row + 0.5) / uSrcSize.y)).r;
    // Brighter spots bloom wider.
    float sigma = mix(uScanMin, uScanMax, lum);
    float dy = rowF - row;
    total += lum * exp(-0.5 * dy * dy / (sigma * sigma));
  }

  float prev = texture(uPrev, uv).r;
  fragColor = vec4(max(total, prev * uDecay), 0.0, 0.0, 1.0);
}`

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOutSize;
uniform vec2 uDir;
uniform float uThreshold;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  vec2 step = uDir / uOutSize;
  float w[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
  float acc = 0.0;
  for (int i = -4; i <= 4; i++) {
    float s = texture(uTex, uv + step * float(i)).r;
    acc += max(s - uThreshold, 0.0) * w[i < 0 ? -i : i];
  }
  fragColor = vec4(acc, 0.0, 0.0, 1.0);
}`

const COMPOSITE = `#version 300 es
precision highp float;
// Required: integers default to mediump, which is only guaranteed 16 bits, and
// the hash below relies on 32-bit multiply wraparound. ANGLE and mobile honour
// the default and produce banded, repeating grain without this.
precision highp int;
uniform sampler2D uScreen;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uPhosphor;
uniform float uFill, uCurve, uBloomAmt, uMaskAmt, uMaskPitch, uVignette;
uniform float uNoise, uFlicker, uRoll, uRollSpeed, uChroma, uBrightness, uAmbient, uBg, uGlass;
uniform float uNoiseStreak, uSnow;
out vec4 fragColor;

// Integer bit mixing rather than fract(sin(dot(...))). The sine hash is smooth,
// so nearby seeds give nearby results and shifting the seed translates the noise
// field instead of reseeding it; it also depends on sin() precision at large
// arguments, which varies by GPU. Here every input bit affects every output bit,
// so consecutive frames are independent.
uint bits(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}

// Time is a separate coordinate, never added into the spatial ones.
float hash(vec3 p) {
  return float(bits(uvec3(ivec3(p))) & 0xffffffu) / 16777215.0;
}

// Barrel distortion, normalised so the corners land on the raster edge. Without
// the divisor the warp magnifies and clips column 0.
vec2 warp(vec2 q, float k) {
  return 0.5 + 0.5 * q * (1.0 + k * dot(q, q)) / (1.0 + 2.0 * k);
}

float roundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  // Normalised so the 4:3 faceplate fits the narrow axis. At or above 4:3 this
  // is the height; below it the width binds, which stops a narrow canvas
  // cropping the ends off every line.
  float s = min(uRes.x / (4.0 / 3.0), uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / s * 2.0;
  vec2 halfSz = vec2(uFill * 4.0 / 3.0, uFill);

  vec2 q = p / halfSz;
  vec2 uv = warp(q, uCurve);

  // --- surround -------------------------------------------------------------
  // No bezel. Only light spilled from the tube.
  vec3 col = uPhosphor * uAmbient * exp(-2.2 * length(p));

  // --- glass -----------------------------------------------------------------
  // Defined in warped space so the outline follows the barrel curve and always
  // contains the swept raster. In flat screen space it only holds at low
  // curvature: the raster bows outward as uCurve rises and gets cropped.
  float edge = smoothstep(0.004, -0.004,
                          roundedBox(uv - 0.5, vec2(0.5 + uGlass), 0.035));

  if (edge > 0.0) {
    // Frame counter for anything that changes once per frame and holds within
    // it. Wrapped at 1024: uTime is seconds since load, and in the thousands a
    // float32 cannot resolve a per-frame step. Quantising at 60 keeps the noise
    // at video rate on a 120Hz panel.
    float nt = mod(floor(uTime * 60.0), 1024.0);

    // Outside the swept raster, dark.
    vec2 g = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    float raster = g.x * g.y;

    // Beam misconvergence, exaggerated into a colour fringe.
    float o = uChroma * 0.0018;
    vec3 lum = vec3(
      texture(uScreen, uv + vec2(o, 0.0)).r,
      texture(uScreen, uv).r,
      texture(uScreen, uv - vec2(o, 0.0)).r
    ) * raster;

    vec3 glass = uPhosphor * lum * uBrightness;

    // Glow blooms toward white.
    float bl = texture(uBloom, uv).r * raster;
    glass += mix(uPhosphor, vec3(1.0), 0.35) * bl * uBloomAmt;

    // Aperture grille, evaluated in device pixels.
    glass *= 1.0 - uMaskAmt * (0.5 + 0.5 * cos(gl_FragCoord.x * 6.2831853 / uMaskPitch));

    // Rolling shutter bar. A camera artefact, not a CRT one. Speed is how many
    // times a second the bar crosses the screen, controlled separately from
    // depth.
    float band = fract(uv.y - uTime * uRollSpeed);
    glass *= 1.0 + uRoll * exp(-pow((band - 0.5) / 0.09, 2.0));

    glass *= 1.0 - uVignette * dot(q, q);
    glass *= 1.0 + uFlicker * (hash(vec3(1.0, 7.0, nt)) - 0.5);

    // --- analogue noise ---
    // Video noise, not film grain. Three differences:
    //
    //   1. The amplifier has finite bandwidth, so a spike smears along the line
    //      into a short dash. Quantising x before hashing produces that.
    //   2. Per-line gain varies.
    //   3. Noise is multiplicative on the video, so it grows where the beam is
    //      lit rather than sitting on top at a constant level.
    float nx = floor(gl_FragCoord.x / max(uNoiseStreak, 1.0));
    float ny = gl_FragCoord.y;

    float grain = hash(vec3(nx, ny, nt)) - 0.5;
    float lineGain = 0.55 + 0.9 * hash(vec3(ny, nt, 5.0));
    float carrier = 0.3 + 0.7 * lum.g;
    glass += grain * lineGain * carrier * uNoise;

    // Sparse one-frame specks: signal dropouts. Aligned to the same horizontal
    // cells as the grain, tinted by the phosphor, riding the same carrier.
    float speck = hash(vec3(nx, ny, nt + 4096.0));
    float pop = step(1.0 - uSnow, speck) * (0.18 + 0.3 * hash(vec3(nx, ny, nt + 8192.0)));
    glass += uPhosphor * pop * carrier;

    // Unlit-tube floor, tinted by the phosphor rather than neutral grey.
    glass += uPhosphor * uBg + vec3(0.005);
    glass += vec3(0.030) * exp(-7.0 * length(q - vec2(-0.40, 0.52)));

    col = mix(col, glass, edge);
  }

  fragColor = vec4(col, 1.0);
}`

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
