//
// Sound effects module for doom.wasm: hands each effect to the host through the `sound` import module.
//
// Copyright(C) 2026 the Cyberspace Terminal contributors
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// The host mixes and plays. The engine passes the raw DMX lump (format 3 header, 8-bit unsigned PCM), the channel, volume 0-127 and separation 0-254 (128 is centre).
// Lumps are passed by pointer on every start; the host keys its decoded copy on the lump number.

#include <stddef.h>
#include <stdint.h>

#include "doomtype.h"
#include "i_sound.h"
#include "m_misc.h"
#include "w_wad.h"
#include "z_zone.h"

#define IMPORT(name) __attribute__((import_module("sound"), import_name(name)))

IMPORT("startSound")
void wasm_startSound(int32_t channel, int32_t lumpnum, const uint8_t *data, int32_t length, int32_t vol, int32_t sep);
IMPORT("stopSound") void wasm_stopSound(int32_t channel);
IMPORT("updateSoundParams") void wasm_updateSoundParams(int32_t channel, int32_t vol, int32_t sep);
IMPORT("isSoundPlaying") int32_t wasm_isSoundPlaying(int32_t channel);

static snddevice_t sound_devices[] = {
    SNDDEVICE_SB,     SNDDEVICE_PAS,         SNDDEVICE_GUS,
    SNDDEVICE_WAVEBLASTER, SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32,
};

static boolean use_prefix;

static boolean Init(boolean use_sfx_prefix) {
  use_prefix = use_sfx_prefix;
  return true;
}

static void Shutdown(void) {}

static int GetSfxLumpNum(sfxinfo_t *sfx) {
  char name[9];

  if (sfx->link != NULL) {
    sfx = sfx->link;
  }
  if (use_prefix) {
    M_snprintf(name, sizeof(name), "ds%s", sfx->name);
  } else {
    M_snprintf(name, sizeof(name), "%s", sfx->name);
  }
  return W_CheckNumForName(name);
}

static void Update(void) {}

static void UpdateSoundParams(int channel, int vol, int sep) {
  wasm_updateSoundParams(channel, vol, sep);
}

static int StartSound(sfxinfo_t *sfx, int channel, int vol, int sep) {
  int lumpnum = sfx->lumpnum;

  // A sound missing from the WAD has lump -1; s_sound treats -1 as a failed start.
  if (lumpnum < 0) {
    return -1;
  }
  wasm_startSound(channel, lumpnum, W_CacheLumpNum(lumpnum, PU_CACHE), W_LumpLength(lumpnum), vol, sep);
  return channel;
}

static void StopSound(int channel) { wasm_stopSound(channel); }

static boolean SoundIsPlaying(int channel) {
  return wasm_isSoundPlaying(channel) != 0;
}

static void CacheSounds(sfxinfo_t *sounds, int num_sounds) {}

sound_module_t wasm_sound_module = {
    sound_devices,
    sizeof(sound_devices) / sizeof(*sound_devices),
    Init,
    Shutdown,
    GetSfxLumpNum,
    Update,
    UpdateSoundParams,
    StartSound,
    StopSound,
    SoundIsPlaying,
    CacheSounds,
};
