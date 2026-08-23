/**
 * Sound notification utilities for session status events.
 * Plays sounds when sessions complete or need input.
 *
 * Playback goes through the Web Audio API (decode into an AudioBuffer, then
 * play through a shared AudioContext) rather than an `<audio>` element. On
 * Linux, Tauri's WebKitGTK webview blocks `HTMLMediaElement.play()` that isn't
 * triggered by a user gesture (and fails to play these clips even from the
 * settings preview), which made every option collapse to the same fallback
 * beep. The Web Audio path is not subject to that media-element gate, and the
 * WAV/PCM assets decode without any optional GStreamer codec on any platform.
 */

import {
  type AppPreferences,
  type NotificationSound,
  notificationSoundOptions,
} from '../types/preferences'
import { isNativeApp } from './environment'

interface NotificationSoundPlaybackOptions {
  webAccessSoundsEnabled?: boolean
}

const notificationSoundAssetMap: Partial<Record<NotificationSound, string>> = {
  workwork: '/sounds/work-work.wav',
  jobsdone: '/sounds/jobs-done.wav',
}

// Distinct synthesized tones per sound, used only when the asset cannot be
// decoded/played. Keeping them distinct ensures the two options never sound
// identical even on a webview/browser that can't play the clips.
const fallbackBeepMap: Partial<
  Record<NotificationSound, { frequency: number; type: OscillatorType }>
> = {
  workwork: { frequency: 660, type: 'square' },
  jobsdone: { frequency: 880, type: 'sine' },
}

// Shared audio context (reused to avoid creating many contexts).
let audioContext: AudioContext | null = null
// Currently playing source, stopped before a new sound to prevent overlap.
let currentSource: AudioBufferSourceNode | null = null
// Monotonic id for the latest playback request. The async load below resolves
// out of order (cached sounds resolve before ones still being fetched/decoded),
// so a stale completion must not start playback after a newer request.
let playRequestId = 0
// Decoded buffers, keyed by sound, for instant repeat playback.
const bufferCache = new Map<NotificationSound, AudioBuffer>()
// In-flight decode promises, to dedupe concurrent loads of the same sound.
const decodePromises = new Map<NotificationSound, Promise<AudioBuffer | null>>()

function getAudioContext(): AudioContext | null {
  if (!audioContext) {
    const Ctor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
    if (!Ctor) return null
    try {
      audioContext = new Ctor()
    } catch {
      return null
    }
  }

  // Resume if suspended (the context is unlocked by any prior user gesture).
  if (audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => undefined)
  }

  return audioContext
}

function loadBuffer(
  sound: NotificationSound,
  ctx: AudioContext
): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(sound)
  if (cached) return Promise.resolve(cached)

  const existing = decodePromises.get(sound)
  if (existing) return existing

  const src = notificationSoundAssetMap[sound]
  if (!src) return Promise.resolve(null)

  const promise = (async () => {
    try {
      const response = await fetch(src)
      if (!response.ok) return null
      const data = await response.arrayBuffer()
      const buffer = await ctx.decodeAudioData(data)
      bufferCache.set(sound, buffer)
      return buffer
    } catch {
      return null
    } finally {
      decodePromises.delete(sound)
    }
  })()

  decodePromises.set(sound, promise)
  return promise
}

function stopCurrentSource(): void {
  if (!currentSource) return
  try {
    currentSource.onended = null
    currentSource.stop()
    currentSource.disconnect()
  } catch {
    // Already stopped or never started — ignore.
  }
  currentSource = null
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.onended = () => {
    if (currentSource === source) currentSource = null
  }
  currentSource = source
  source.start()
}

/**
 * Play a synthesized fallback tone when the audio file is unavailable.
 * The tone differs per sound so the options remain distinguishable.
 */
function playFallbackBeep(ctx: AudioContext, sound: NotificationSound): void {
  try {
    const { frequency, type } = fallbackBeepMap[sound] ?? {
      frequency: 800,
      type: 'sine' as OscillatorType,
    }

    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.connect(gain)
    gain.connect(ctx.destination)

    oscillator.frequency.value = frequency
    oscillator.type = type
    gain.gain.value = 0.1

    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.15)
  } catch {
    // Silently fail if Web Audio API is unavailable.
  }
}

/**
 * Play a notification sound. If a sound is already playing, it is stopped first.
 * Falls back to a distinct synthesized beep if the audio file cannot be played.
 */
export function playNotificationSound(
  sound: NotificationSound,
  options: NotificationSoundPlaybackOptions = {}
): void {
  if (sound === 'none') return
  if (!isNativeApp() && options.webAccessSoundsEnabled === false) return

  const ctx = getAudioContext()
  if (!ctx) return

  // Claim the latest request slot so stale async loads can be discarded.
  const requestId = ++playRequestId

  // Stop any currently playing sound to prevent overlap.
  stopCurrentSource()

  loadBuffer(sound, ctx)
    .then(buffer => {
      // A newer request superseded this one — drop the stale completion.
      if (requestId !== playRequestId) return
      if (buffer) {
        playBuffer(ctx, buffer)
      } else {
        playFallbackBeep(ctx, sound)
      }
    })
    .catch(() => {
      if (requestId !== playRequestId) return
      playFallbackBeep(ctx, sound)
    })
}

/**
 * Play the configured "session needs input" sound.
 *
 * `useStreamingEvents.ts` inlines the same mapping: its test file mocks this
 * module and asserts on `playNotificationSound` directly, so routing it through
 * here would hide the sound name those assertions check.
 */
export function playWaitingSound(prefs: AppPreferences | undefined): void {
  playNotificationSound((prefs?.waiting_sound ?? 'none') as NotificationSound, {
    webAccessSoundsEnabled: prefs?.web_access_sounds_enabled ?? true,
  })
}

/**
 * Preload and decode all sound files to ensure instant playback.
 * Call this on app startup.
 */
export function preloadAllSounds(
  options: NotificationSoundPlaybackOptions = {}
): void {
  if (!isNativeApp() && options.webAccessSoundsEnabled === false) return

  const ctx = getAudioContext()
  if (!ctx) return

  for (const option of notificationSoundOptions) {
    if (option.value === 'none') continue
    void loadBuffer(option.value, ctx)
  }
}
