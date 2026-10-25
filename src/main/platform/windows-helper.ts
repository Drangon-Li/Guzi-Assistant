import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'

const children = new Set<ChildProcess>()
let cleanupRegistered = false

export function windowsHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'GuziWindowsHelper.exe')
    : join(app.getAppPath(), 'build', 'native', 'GuziWindowsHelper.exe')
}

function track<T extends ChildProcess>(child: T): T {
  children.add(child)
  const forget = (): void => { children.delete(child) }
  child.once('exit', forget)
  child.once('error', forget)
  child.once('close', forget)
  if (!cleanupRegistered) {
    cleanupRegistered = true
    app.once('before-quit', () => {
      for (const proc of children) proc.kill()
      children.clear()
    })
  }
  return child
}

export function execWindowsHelper(
  args: string[], options: { signal?: AbortSignal; timeout?: number } = {}
): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let result: { error: Error | null; stdout: string } | null = null
    const child = execFile(windowsHelperPath(), args, {
      encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 3000,
      maxBuffer: 2 * 1024 * 1024, signal: options.signal
    }, (error, stdout) => { result = { error, stdout } })
    // AbortError can precede close; callers may remove files only after native handles close.
    child.once('close', () => {
      if (!result) reject(new Error('Windows helper closed without an execution result'))
      else if (result.error) reject(result.error)
      else resolve(result.stdout)
    })
    track(child)
  })
}

/** A closed stdin or a dead Electron parent also stops the native message loop. */
export function spawnWindowsHelper(command: 'collect' | 'clipboard-watch'): ChildProcessWithoutNullStreams {
  return track(spawn(windowsHelperPath(), [command, '--parent-pid', String(process.pid)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  }))
}
