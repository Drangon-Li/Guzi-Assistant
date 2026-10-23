import type { IpcMainInvokeEvent } from 'electron'
import { assertContentEpoch } from './content-lifecycle'

type Listener = (event: IpcMainInvokeEvent, ...args: any[]) => any

export function withContentEpoch(listener: Listener, allowEpochChange = false): Listener {
  return async (event, envelope: { contentEpoch?: number } | null, ...args: unknown[]) => {
    const epoch = envelope?.contentEpoch as number
    assertContentEpoch(epoch)
    const result = await listener(event, ...args)
    if (!allowEpochChange) assertContentEpoch(epoch)
    return result
  }
}
