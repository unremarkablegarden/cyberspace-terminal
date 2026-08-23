// The knobs the tube has, grouped the way CONFIG lists them.
//
// Ranges bracket the default with room either side. They are not physically
// meaningful — several of these look best well past plausible.
//
// Data, next to the shader rather than next to the box that draws it: how far a
// uniform can sensibly go is knowledge about the tube, and the widget reading it
// is one of several that could.

import type { Knob, KnobGroup } from '@cyberspace/tui'

export const DECAY_MAX = 0.98

export const CRT_CONTROLS: KnobGroup[] = [
  {
    title: 'beam',
    knobs: [
      { key: 'beam', min: 0.1, max: 2, step: 0.01, hint: 'horizontal spot sigma' },
      { key: 'sharpen', min: 0, max: 2, step: 0.01, hint: 'amp peaking, h only' },
      { key: 'scanMin', min: 0.05, max: 1, step: 0.01, hint: 'scanline, dark px' },
      { key: 'scanMax', min: 0.05, max: 1.5, step: 0.01, hint: 'scanline, lit px' },
      { key: 'decay', min: 0, max: DECAY_MAX, step: 0.01, hint: 'phosphor persistence' },
    ],
  },
  {
    title: 'bloom',
    knobs: [
      { key: 'threshold', min: 0, max: 1, step: 0.01, hint: 'glow cut-in' },
      { key: 'bloomAmt', min: 0, max: 3, step: 0.01, hint: 'glow strength' },
    ],
  },
  {
    title: 'tube',
    knobs: [
      { key: 'fill', min: 0.4, max: 1, step: 0.005, hint: 'screen size' },
      { key: 'curve', min: 0, max: 0.15, step: 0.001, hint: 'barrel distortion' },
      { key: 'glass', min: 0, max: 0.15, step: 0.002, hint: 'glass beyond raster' },
      { key: 'vignette', min: 0, max: 1, step: 0.01, hint: 'corner falloff' },
      { key: 'brightness', min: 0.2, max: 2, step: 0.01, hint: 'gun drive' },
      { key: 'bg', min: 0, max: 0.3, step: 0.005, hint: 'unlit tube floor' },
      { key: 'ambient', min: 0, max: 0.15, step: 0.002, hint: 'spill on the room' },
    ],
  },
  {
    title: 'mask',
    knobs: [
      { key: 'maskAmt', min: 0, max: 1, step: 0.01, hint: 'aperture grille' },
      { key: 'maskPitch', min: 1, max: 8, step: 0.1, hint: 'device px per stripe' },
      { key: 'chroma', min: 0, max: 3, step: 0.01, hint: 'misconvergence' },
    ],
  },
  {
    title: 'noise',
    knobs: [
      { key: 'noise', min: 0, max: 0.4, step: 0.005, hint: 'grain amount' },
      { key: 'noiseStreak', min: 1, max: 12, step: 0.1, hint: '1 = film grain' },
      { key: 'snow', min: 0, max: 0.01, step: 0.0002, hint: 'dropout specks' },
      { key: 'flicker', min: 0, max: 0.2, step: 0.005, hint: 'frame to frame' },
      { key: 'roll', min: 0, max: 0.6, step: 0.005, hint: 'shutter bar' },
      { key: 'rollSpeed', min: 0, max: 1.5, step: 0.005, hint: 'bar drift, screens/sec' },
    ],
  },
]
