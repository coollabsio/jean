/**
 * Sound notification utilities for session status events.
 * Plays sounds when sessions complete or need input.
 */

export type NotificationSound = 'none' | 'ding' | 'chime' | 'pop' | 'choochoo'

export const notificationSoundOptions: {
  value: NotificationSound
  label: string
}[] = [
  { value: 'none', label: 'None' },
  { value: 'ding', label: 'Ding' },
  { value: 'chime', label: 'Chime' },
  { value: 'pop', label: 'Pop' },
  { value: 'choochoo', label: 'Choo-choo' },
]

const notificationSoundAssetMap: Partial<Record<NotificationSound, string>> = {
  choochoo: '/sounds/peon-work-work.mp3',
}

// Single audio instance to prevent overlapping sounds
let currentAudio: HTMLAudioElement | null = null

// Audio context for system beep fallback (reused to avoid creating many contexts)
let audioContext: AudioContext | null = null

/**
 * Play a notification sound. If a sound is already playing, it will be stopped first.
 * Falls back to a system beep if the audio file is not found or playback fails.
 */
export function playNotificationSound(sound: NotificationSound): void {
  if (sound === 'none') return

  const soundSrc = notificationSoundAssetMap[sound]
  if (!soundSrc) {
    playSystemBeep()
    return
  }

  // Stop any currently playing sound to prevent overlap
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
    currentAudio = null
  }

  const audio = new Audio(soundSrc)
  currentAudio = audio

  audio.play().catch(() => {
    // File not found or autoplay blocked - fallback to system beep
    playSystemBeep()
  })
}

/**
 * Play a synthesized system beep as fallback when audio files are unavailable.
 * Uses Web Audio API to generate a short tone.
 */
function playSystemBeep(): void {
  try {
    // Reuse or create audio context
    if (!audioContext) {
      audioContext = new AudioContext()
    }

    // Resume context if it's suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume()
    }

    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()

    oscillator.connect(gain)
    gain.connect(audioContext.destination)

    // Configure a pleasant notification tone
    oscillator.frequency.value = 800
    oscillator.type = 'sine'
    gain.gain.value = 0.1

    // Play for 150ms
    oscillator.start()
    oscillator.stop(audioContext.currentTime + 0.15)
  } catch {
    // Silently fail if Web Audio API is unavailable
  }
}

// Cache for preloaded audio elements
const audioCache = new Map<NotificationSound, HTMLAudioElement>()

/**
 * Preload all sound files to ensure instant playback.
 * Call this on app startup.
 */
export function preloadAllSounds(): void {
  for (const option of notificationSoundOptions) {
    if (option.value === 'none') continue
    const soundSrc = notificationSoundAssetMap[option.value]
    if (!soundSrc) continue

    const audio = new Audio(soundSrc)
    audio.preload = 'auto'
    audioCache.set(option.value, audio)
  }
}
