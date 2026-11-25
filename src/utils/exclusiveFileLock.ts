/** Nonblocking, process-owned lock on a stable local file. Callers must keep the file in place. */
import {constants as fs} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import path from 'node:path';

type NativeLock = (fd: number) => (() => void) | undefined;
let nativeLock: Promise<NativeLock> | undefined;

async function loadNativeLock(): Promise<NativeLock> {
  const {default: koffi} = await import('koffi');
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : null);
    const flock = libc.func('int flock(int fd, int operation)');
    return fd => {
      if (flock(fd, 2 | 4 /* LOCK_EX | LOCK_NB */) !== 0) return;
      // Closing this descriptor releases the lock.
      return () => {};
    };
  }
  if (process.platform === 'win32') {
    const node = koffi.load(null);
    const getHandle = node.func('intptr_t uv_get_osfhandle(int fd)');
    const system = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'kernel32.dll');
    const kernel = koffi.load(system);
    const lock = kernel.func('int __stdcall LockFile(intptr_t handle, uint32_t offset, uint32_t offsetHigh, uint32_t length, uint32_t lengthHigh)');
    const unlock = kernel.func('int __stdcall UnlockFile(intptr_t handle, uint32_t offset, uint32_t offsetHigh, uint32_t length, uint32_t lengthHigh)');
    return fd => {
      const handle = getHandle(fd);
      if (handle === -1 || handle === -1n || !lock(handle, 0, 0, 1, 0)) return;
      return () => { if (!unlock(handle, 0, 0, 1, 0)) throw new Error('Cannot release the update lock'); };
    };
  }
  throw new Error('Native file locks are unavailable');
}

export async function tryExclusiveFileLock(file: string): Promise<(() => Promise<void>) | undefined> {
  nativeLock ??= loadNativeLock();
  const lock = await nativeLock;
  const existing = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && !existing.isFile()) throw new Error('Update lock must be a regular file');

  const handle = await open(file, fs.O_CREAT | fs.O_RDWR | (fs.O_NOFOLLOW ?? 0) | (fs.O_NONBLOCK ?? 0), 0o600);
  let acquired = false;
  try {
    const opened = await handle.stat({bigint: true});
    const named = await lstat(file, {bigint: true});
    if (!opened.isFile() || opened.nlink !== 1n || !named.isFile() || named.nlink !== 1n ||
        opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('Update lock changed while opening');
    const unlock = lock(handle.fd);
    if (!unlock) return;
    acquired = true;
    return async () => {
      try { unlock(); }
      finally { await handle.close(); }
    };
  } finally {
    if (!acquired) await handle.close();
  }
}
