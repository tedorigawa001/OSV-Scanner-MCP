/** Resolve the opened object through the OS, never by walking its mutable name. */
import { readlink } from "node:fs/promises";
import path from "node:path";

type NativePath = (fd: number) => string;
let nativePath: Promise<NativePath> | undefined;

async function loadNativePath(): Promise<NativePath> {
  const { default: koffi } = await import("koffi");
  if (process.platform === "darwin") {
    const libc = koffi.load("/usr/lib/libSystem.B.dylib");
    // fcntl really is variadic (notably a different ABI on Apple arm64).
    const fcntl = libc.func("int fcntl(int fd, int cmd, ...)");
    return (fd) => {
      const buffer = Buffer.alloc(1024); // Darwin MAXPATHLEN, including NUL
      if (fcntl(fd, 50 /* F_GETPATH */, "void *", buffer) !== 0) throw new Error("F_GETPATH failed");
      const end = buffer.indexOf(0);
      if (end < 1) throw new Error("Invalid F_GETPATH result");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
    };
  }
  if (process.platform === "win32") {
    // Use Node's own libuv export: another CRT's fd table need not match Node's.
    const node = koffi.load(null);
    const getHandle = node.func("intptr_t uv_get_osfhandle(int fd)");
    const system = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "kernel32.dll");
    const kernel = koffi.load(system);
    const getPath = kernel.func("uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t handle, void *buffer, uint32_t size, uint32_t flags)");
    return (fd) => {
      const handle = getHandle(fd);
      if (handle === -1 || handle === -1n) throw new Error("Invalid file handle");
      const capacity = 32768;
      const buffer = Buffer.alloc(capacity * 2);
      const length = getPath(handle, buffer, capacity, 0);
      if (length === 0 || length >= capacity) throw new Error("GetFinalPathNameByHandleW failed");
      const value = buffer.toString("utf16le", 0, length * 2);
      if (value.startsWith("\\\\?\\UNC\\")) return "\\\\" + value.slice(8);
      if (value.startsWith("\\\\?\\")) return value.slice(4);
      throw new Error("Unexpected Windows file namespace");
    };
  }
  throw new Error("Opened-file path verification is unavailable on this platform");
}

export async function openedFilePath(fd: number): Promise<string> {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Invalid file descriptor");
  let resolved: string;
  if (process.platform === "linux") {
    // readlink returns the kernel's descriptor target. realpath would introduce
    // another attacker-controlled pathname walk and recreate the race.
    resolved = await readlink(`/proc/self/fd/${fd}`);
    if (resolved.endsWith(" (deleted)")) throw new Error("Opened file was deleted");
  } else {
    nativePath ??= loadNativePath();
    resolved = (await nativePath)(fd);
  }
  if (!path.isAbsolute(resolved) || resolved.includes("\0")) throw new Error("Invalid opened-file path");
  return resolved;
}
