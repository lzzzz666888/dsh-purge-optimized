// 只删"目录项"，绝不进入符号链接 / Windows junction 的内部。
// 原生 fs.rmSync({recursive:true}) 在 Windows 上会穿进 junction 把目标目录内容一起删掉 ——
// 插件要清的是自己的临时目录和解包副本，一旦那里恰好有个链接（pnpm 布局里很常见），
// 原生递归删除就会删到插件目录甚至宿主运行时里去。
//
// 另外：删文件系统根必须直接拒绝，不能靠调用方自觉。
import fs from "node:fs";
import path from "node:path";

const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

function guardRoot(target) {
  const root = path.resolve(target);
  if (root === path.parse(root).root) throw Error("拒绝删除文件系统根目录");
  return root;
}

export function removeTreeNoFollowSync(target, options = {}) {
  const io = options.fs || fs;
  const root = guardRoot(target);
  const maxRetries = options.maxRetries ?? 0;
  const retryDelay = options.retryDelay ?? 100;
  const walk = (file) => {
    let stat;
    try {
      stat = io.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    // lstat 必须早于 isDirectory：删除目标永远不能 stat/realpath 穿透。
    try {
      if (stat.isSymbolicLink()) {
        io.unlinkSync(file);
        return;
      }
      if (stat.isDirectory()) {
        for (const name of io.readdirSync(file)) walk(path.join(file, name));
        io.rmdirSync(file); // 非递归：不给原生递归实现留后路
      } else {
        io.unlinkSync(file);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      walk(root);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (attempt >= maxRetries || !RETRYABLE.has(error.code)) throw error;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay * (attempt + 1));
      } catch {
        const until = Date.now() + retryDelay * (attempt + 1);
        while (Date.now() < until) { /* busy wait */ }
      }
    }
  }
}

export async function removeTreeNoFollow(target, options = {}) {
  const io = (options.fs || fs).promises;
  const root = guardRoot(target);
  const maxRetries = options.maxRetries ?? 0;
  const retryDelay = options.retryDelay ?? 100;
  const walk = async (file) => {
    let stat;
    try {
      stat = await io.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    try {
      if (stat.isSymbolicLink()) {
        await io.unlink(file);
        return;
      }
      if (stat.isDirectory()) {
        for (const name of await io.readdir(file)) await walk(path.join(file, name));
        await io.rmdir(file);
      } else {
        await io.unlink(file);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await walk(root);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (attempt >= maxRetries || !RETRYABLE.has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)));
    }
  }
}
