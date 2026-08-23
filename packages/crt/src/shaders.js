// The GLSL. One string per program; the pipeline that runs them is crt.js.
//
// All of it is #version 300 es, drawn as a single full-screen triangle from
// gl_VertexID — there is no vertex buffer anywhere in this package.

export const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// The spot convolution is separable. Running the horizontal half at source
// resolution costs 3 texture fetches per output pixel instead of 21. Do not
// inline it into the beam pass.
export const SPOT_H = `#version 300 es
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

export const BEAM = `#version 300 es
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

export const BLUR = `#version 300 es
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

export const COMPOSITE = `#version 300 es
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
  // No bezel: only light spilled from the screen itself.
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
