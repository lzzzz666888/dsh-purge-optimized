import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/** 当前已接线的宿主面。gui / tui 先能识别，适配仍回退 web。 */
export const SURFACES = Object.freeze(["web", "desktop", "gui", "tui"]);

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function exeName(execPath) {
  return path.basename(String(execPath || "")).toLowerCase();
}

export function pathLooksDesktop(p) {
  const n = slash(p);
  if (!n) return false;
  // 安装目录可能叫 "DeepSeek Harness" / "deepseek-harness" / "DeepseekHarnessDesktop"。
  // 源码仓库也常带 deepseek-harness 名字，所以还要带 resources/、exe、.app/ 才算桌面安装。
  const harnessDir =
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness/.test(n);
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.includes("dsh-desktop") ||
    n.includes("dsh-plugin-desktop") ||
    n.includes("dsh-desktop-next") ||
    n.includes("/dsh next/") ||
    n.includes("/dsh next.app/") ||
    n.includes("dsh-next") ||
    n.includes("/deepseek bot/") ||
    n.includes("/deepseek-bot/") ||
    n.includes("/ds-bot/") ||
    n.includes("/deepseek harness.app/") ||
    (harnessDir && (n.includes("/resources/") || n.includes("/contents/resources/") || n.endsWith("/resources"))) ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/dsh next\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n) ||
    n.endsWith("/host-process-entry.js") ||
    n.endsWith("/desktop-cli.js")
  );
}

function resourcesLookLikeDesktopInstall(resourcesPath) {
  if (!resourcesPath) return false;
  if (pathLooksDesktop(resourcesPath)) return true;
  const n = slash(resourcesPath);
  if (!(n.endsWith("/resources") || n.includes("/contents/resources"))) return false;
  try {
    const asar = path.join(resourcesPath, "app.asar");
    if (fs.existsSync(asar) && fs.statSync(asar).isFile()) return true;
    if (fs.existsSync(path.join(resourcesPath, "app", "dsh"))) return true;
    if (fs.existsSync(path.join(resourcesPath, "app.asar.unpacked", "dsh"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 社区 Electron（DS Bot / DeepSeek Bot）：profile 常是 ds-bot，DSH_SURFACE 还可能被写成 web。 */
export function isCommunityElectronHost(input = {}) {
  const env = input.env ?? process.env;
  const profile = norm(env.DSH_PROFILE);
  if (profile === "ds-bot" || profile === "dsbot" || profile === "deepseek-bot") return true;
  if (profile === "dsh-next" || profile === "dshnext" || profile === "dsh next") return true;
  const execPath = input.execPath ?? process.execPath;
  const name = exeName(execPath);
  if (/^deepseek[\s._-]*bot(\.exe)?$/.test(name) || /^ds[\s._-]*bot(\.exe)?$/.test(name)) return true;
  if (/^dsh[\s._-]*next(\.exe)?$/.test(name)) return true;
  const p = slash(execPath);
  if (p.includes("/deepseek bot") || p.includes("/deepseek-bot") || p.includes("/ds-bot/") || p.endsWith("/ds-bot")) return true;
  if (p.includes("/dsh next") || p.includes("/dsh-next")) return true;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const electron = (input.versions ?? process.versions)?.electron;
  if (electron && resourcesLookLikeDesktopInstall(resourcesPath)) return true;
  return false;
}

export function isDesktopSurface(input = {}) {
  const env = input.env ?? process.env;
  if (isCommunityElectronHost(input)) return true;
  const forced = norm(env.DSH_SURFACE);
  if (forced === "desktop") return true;
  if (forced && SURFACES.includes(forced)) return false;

  const execPath = input.execPath ?? process.execPath;
  const name = exeName(execPath);
  if (
    name === "dsh desktop.exe" ||
    name === "dsh desktop" ||
    name === "dsh next.exe" ||
    name === "dsh next" ||
    name === "deepseek harness.exe" ||
    name === "deepseek-harness.exe" ||
    name === "deepseek harness" ||
    name === "deepseek-harness" ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(name) ||
    /^dsh[\s._-]*next(\.exe)?$/.test(name)
  ) return true;
  if (pathLooksDesktop(execPath)) return true;

  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  if (resourcesLookLikeDesktopInstall(resourcesPath)) return true;

  const argv = input.argv ?? process.argv;
  if ((Array.isArray(argv) ? argv : []).some((arg) => pathLooksDesktop(arg))) return true;

  const parentPort = input.parentPort !== undefined ? input.parentPort : process.parentPort;
  if (parentPort && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;

  if (env.ELECTRON_RUN_AS_NODE && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;
  return false;
}

function forcedSurface(env) {
  const forced = norm(env.DSH_SURFACE);
  return SURFACES.includes(forced) ? forced : "";
}

/**
 * 插件自己记下的桌面安装目录（dsh-purge/desktop-install.txt）。
 * 纯 node 跑 CLI 时 execPath 是 node.exe，靠它认不出桌面面 ——
 * 结果 --status 报 web、desktop-shell / pi-ai 三个键全 undefined，
 * #45/#82/#83/#93 一律 missing_file。有这个记录就直接认桌面。
 */
export function recordedDesktopInstall(env = process.env) {
  const home = norm(env.DSH_HOME) || os.homedir() + "/.dsh";
  try {
    const fp = path.join(home.replace(/\//g, path.sep), "dsh-purge", "desktop-install.txt");
    const dir = fs.readFileSync(fp, "utf8").trim();
    if (!dir) return "";
    const exe = path.join(dir.replace(/\//g, path.sep));
    if (!fs.existsSync(exe)) return "";
    return exe;
  } catch {
    return "";
  }
}

export function detectSurface(input = {}) {
  const env = input.env ?? process.env;
  if (isCommunityElectronHost(input)) return "desktop";
  const forced = forcedSurface(env);
  if (forced) return forced;
  if (isDesktopSurface(input)) return "desktop";
  // CLI / 外部 node 进程：进程本身看不出是桌面，但插件记录过桌面安装目录。
  if (!forced && recordedDesktopInstall(env)) return "desktop";
  return "web";
}

/** gui / tui 尚未单独适配，先走 web 重启与探测。 */
export function adapterFor(kind) {
  return kind === "desktop" ? "desktop" : "web";
}
