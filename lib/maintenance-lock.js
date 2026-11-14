// 维护互斥：apply / revert 会改写宿主源码，两个进程同时干这件事必然互相踩。
// 现实里真会发生：面板点「应用」的同时 CLI 也在跑，或者启动 settle 与 MCP 工具撞上。
//
// 设计取舍：
// - 用目录当锁（mkdir 原子），里面放 owner.json，不依赖 flock（Windows 上没有）。
// - 归属校验带 pid **和** 进程启动时间：PID 会被复用，只看 pid 会把"别人的进程"当成自己人。
// - 进程探活只认 ESRCH，EPERM/未知一律当作"还活着" —— 宁可让用户看见 MAINTENANCE_BUSY，
//   也不要因为权限读不到就把正在写盘的进程判死、抢锁进去把文件写坏。
// - 退出时释放；进程被强杀留下的锁，靠 pid+start 判死后回收。
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

function dshHome() {
  const env = String(process.env.DSH_HOME || "").trim();
  return env || path.join(os.homedir(), ".dsh");
}

export const LOCK_DIR = "maintenance.lock";

function lockPath(base) {
  return path.join(base || dshHome(), "dsh-purge", LOCK_DIR);
}

function ownerFile(dir) {
  return path.join(dir, "owner.json");
}

/** 进程启动时间（毫秒）。取不到返回 0 —— 调用方按"未知"处理，不会当成已死。 */
function processBirth(pid) {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 });
      const ticks = Number(String(out).trim());
      return Number.isFinite(ticks) && ticks > 0 ? Math.round((ticks - 621355968000000000) / 10000) : 0;
    } catch {
      return 0;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const t = Date.parse(String(out).trim());
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** 只认 ESRCH 为死亡。EPERM 表示进程在、只是无权探测。 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

function ownerDead(owner) {
  if (!owner || !Number.isInteger(owner.pid)) return true;
  if (!alive(owner.pid)) return true;
  const birth = processBirth(owner.pid);
  // 启动时间比锁的创建还晚 → PID 被复用了，原来的持有者已经死了。
  if (birth > 0 && owner.createdAt && birth > owner.createdAt + 2000) return true;
  return false;
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(dir), "utf8"));
  } catch {
    return null;
  }
}

export function lockStatus(base) {
  const dir = lockPath(base);
  if (!fs.existsSync(dir)) return { locked: false, dir };
  const owner = readOwner(dir);
  return { locked: !ownerDead(owner), dir, owner, stale: Boolean(owner) && ownerDead(owner) };
}

/**
 * 取锁。成功返回 release()；被占用抛 code=MAINTENANCE_BUSY 的错误。
 * @param {{base?: string, what?: string, waitMs?: number}} options
 */
export function acquireMaintenanceLock(options = {}) {
  const base = options.base;
  const dir = lockPath(base);
  const what = options.what || "apply";
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 0;
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const now = Date.now();
    const owner = {
      pid: process.pid,
      host: os.hostname(),
      createdAt: now,
      birth: processBirth(process.pid),
      what,
    };
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(ownerFile(dir), JSON.stringify(owner), { mode: 0o600 });
      let released = false;
      return {
        dir,
        owner,
        release() {
          if (released) return;
          released = true;
          const cur = readOwner(dir);
          // 只释放自己的锁：别人的（或已被回收后重建的）不能删。
          if (cur && cur.pid === process.pid && cur.createdAt === owner.createdAt) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 下次自己会被判过期 */ }
          }
        },
      };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const holder = readOwner(dir);
      if (holder && ownerDead(holder)) {
        // 强杀留下的死锁：回收。rm 失败就继续等，不硬闯。
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        } catch { /* fallthrough */ }
      }
      if (Date.now() >= deadline) {
        const err = new Error(
          `另一个 dsh-purge 维护进程正在运行（pid=${holder?.pid ?? "?"}, what=${holder?.what ?? "?"}）。`
          + `等它结束后重试；确认它已经不在了可以删掉 ${dir}`,
        );
        err.code = "MAINTENANCE_BUSY";
        err.owner = holder;
        throw err;
      }
      // 同步等待：apply 是同步串行流程，没有 await 点可用。
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      } catch {
        const until = Date.now() + 200;
        while (Date.now() < until) { /* busy wait */ }
      }
    }
  }
}

/** 包一层：正常返回/抛错都释放锁。 */
export function withMaintenanceLock(options, fn) {
  const lock = acquireMaintenanceLock(options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}
