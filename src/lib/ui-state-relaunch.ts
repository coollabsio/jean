type UIStateRelaunchSaver = () => Promise<void>

let saveBeforeRelaunch: UIStateRelaunchSaver | null = null

export function registerUIStateRelaunchSaver(
  saver: UIStateRelaunchSaver | null
): void {
  saveBeforeRelaunch = saver
}

export async function flushUIStateBeforeRelaunch(): Promise<void> {
  await saveBeforeRelaunch?.()
}

export async function relaunchAfterUIStateSave(
  relaunch: () => Promise<void>
): Promise<void> {
  try {
    await flushUIStateBeforeRelaunch()
  } finally {
    await relaunch()
  }
}
