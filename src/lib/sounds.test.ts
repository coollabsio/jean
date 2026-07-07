import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let nativeApp = false

vi.mock('./environment', () => ({
  isNativeApp: () => nativeApp,
}))

// --- Web Audio mocks ---------------------------------------------------------

const oscStart = vi.fn()
const oscStop = vi.fn()

// Buffers passed to every started AudioBufferSourceNode, in start order.
const startedBuffers: unknown[] = []
// Captured oscillators so tests can inspect frequency/type of fallback tones.
const createdOscillators: MockOscillator[] = []

class MockBufferSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn(function (this: MockBufferSource) {
    startedBuffers.push(this.buffer)
  })
  stop = vi.fn()
}

class MockOscillator {
  frequency = { value: 0 }
  type = ''
  connect = vi.fn()
  start = oscStart
  stop = oscStop
}

class MockGain {
  gain = { value: 0 }
  connect = vi.fn()
}

const decodeAudioData = vi.fn()
const audioContextConstructor = vi.fn()

class MockAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  resume = vi.fn(() => Promise.resolve())
  createBufferSource = vi.fn(() => new MockBufferSource())
  createOscillator = vi.fn(() => {
    const osc = new MockOscillator()
    createdOscillators.push(osc)
    return osc
  })
  createGain = vi.fn(() => new MockGain())
  decodeAudioData = decodeAudioData

  constructor() {
    audioContextConstructor()
  }
}

const fetchMock = vi.fn()

describe('notification sounds', () => {
  beforeEach(() => {
    nativeApp = false
    startedBuffers.length = 0
    createdOscillators.length = 0
    vi.clearAllMocks()
    vi.resetModules()

    decodeAudioData.mockResolvedValue({ duration: 1 })
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })

    vi.stubGlobal('AudioContext', MockAudioContext)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch or play audio when web access sounds are disabled', async () => {
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork', { webAccessSoundsEnabled: false })
    await Promise.resolve()

    expect(audioContextConstructor).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(startedBuffers).toHaveLength(0)
  })

  it('still plays sounds in the native app when the web access flag is disabled', async () => {
    nativeApp = true
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork', { webAccessSoundsEnabled: false })

    await vi.waitFor(() => expect(startedBuffers).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith('/sounds/work-work.wav')
  })

  it('plays a distinct fallback tone per sound when decoding fails', async () => {
    nativeApp = true
    decodeAudioData.mockRejectedValue(new Error('no codec'))
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork')
    await vi.waitFor(() => expect(oscStart).toHaveBeenCalledTimes(1))
    playNotificationSound('jobsdone')
    await vi.waitFor(() => expect(oscStart).toHaveBeenCalledTimes(2))

    expect(createdOscillators).toHaveLength(2)
    const [workworkOsc, jobsdoneOsc] = createdOscillators
    expect(workworkOsc?.frequency.value).not.toBe(jobsdoneOsc?.frequency.value)
  })

  it('awaits resume before playing when the audio context starts suspended', async () => {
    nativeApp = true
    let resolveResume: (() => void) | undefined
    const resumePromise = new Promise<void>(resolve => {
      resolveResume = resolve
    })

    class SuspendedAudioContext extends MockAudioContext {
      override state = 'suspended'
      override resume = vi.fn(() => {
        const promise = resumePromise.then(() => {
          this.state = 'running'
        })
        return promise
      })
    }

    vi.stubGlobal('AudioContext', SuspendedAudioContext)

    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork')
    expect(startedBuffers).toHaveLength(0)

    resolveResume?.()
    await resumePromise
    await vi.waitFor(() => expect(startedBuffers).toHaveLength(1))
  })

  it('ignores a stale decode so only the latest requested sound plays', async () => {
    nativeApp = true

    // Distinct buffers per sound; decodeAudioData resolves are controlled
    // manually so the FIRST request (workwork) can finish AFTER the second
    // (jobsdone), reproducing the out-of-order completion race.
    const workworkBuffer = { tag: 'workwork' }
    const jobsdoneBuffer = { tag: 'jobsdone' }
    const buffersByCall = [workworkBuffer, jobsdoneBuffer]
    const resolvers: (() => void)[] = []
    let decodeCall = 0
    decodeAudioData.mockImplementation(
      () =>
        new Promise(resolve => {
          const buffer = buffersByCall[decodeCall++]
          resolvers.push(() => resolve(buffer))
        })
    )

    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork') // request 1 (will be superseded)
    playNotificationSound('jobsdone') // request 2 (latest)

    await vi.waitFor(() => expect(decodeAudioData).toHaveBeenCalledTimes(2))

    // Latest request resolves first and plays.
    resolvers[1]?.()
    await vi.waitFor(() => expect(startedBuffers).toHaveLength(1))

    // Stale request resolves later — it must NOT start playback.
    resolvers[0]?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(startedBuffers).toHaveLength(1)
    expect(startedBuffers[0]).toBe(jobsdoneBuffer)
  })

  it('skips preloading in web access when sounds are disabled', async () => {
    const { preloadAllSounds } = await import('./sounds')

    preloadAllSounds({ webAccessSoundsEnabled: false })
    await Promise.resolve()

    expect(audioContextConstructor).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preloads and decodes every sound asset in the native app', async () => {
    nativeApp = true
    const { preloadAllSounds } = await import('./sounds')

    preloadAllSounds()

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledWith('/sounds/work-work.wav')
    expect(fetchMock).toHaveBeenCalledWith('/sounds/jobs-done.wav')
  })
})
