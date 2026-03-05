/**
 * Sound notification utilities for session status events.
 * Plays sounds when sessions complete or need input.
 *
 * Sound IDs: "none" | "system:<name>" | "custom:<filename>"
 */

import { invoke, convertFileSrc } from '@/lib/transport'

// Single audio instance to prevent overlapping sounds
let currentAudio: HTMLAudioElement | null = null

/**
 * Play a notification sound by its ID.
 * Resolves the sound file path via the backend, then plays via asset protocol.
 */
export async function playNotificationSound(soundId: string): Promise<void> {
  if (!soundId || soundId === 'none') return

  // Stop any currently playing sound to prevent overlap
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
    currentAudio = null
  }

  try {
    const filePath = await invoke<string | null>('get_sound_file_path', {
      soundId,
    })
    if (!filePath) return

    const url = convertFileSrc(filePath)
    const audio = new Audio(url)
    currentAudio = audio
    await audio.play()
  } catch {
    // Sound file not found or playback failed — silent fail
  }
}
