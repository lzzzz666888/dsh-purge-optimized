// 锚点漂移诊断 + 半自动重锚。
//
// 宿主每升级一次，官方就会搬代码/改缩进，补丁锚点（pattern）随之失效。
// 旧流程是先发现「状态页红了」→ 人去宿主里 grep → 改插件源码 → 发版。
// 有这两个命令之后，现场就能完成：
//   dsh-purge --diagnose                 # 每条漂移补丁：文件、行号、旧锚点首行、候选落点
//   dsh-purge --reanchor 13 --lines 42-44 --yes
// 重锚结果写 $DSH_HOME/dsh-purge/anchor-overrides.json（见 lib/anchors.js），
// 不动插件源码，清掉文件即恢复出厂锚点。
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";
import { clearOverride, readOverrides, writeOverride } from "./anchors.js";

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{5,}/g;
const STRING = /"[^"\n]{6,}"|'[^'\n]{6,}'|`[^`\n]{6,}`/g;

function patternText(rep) {
  if (!rep) return "";
  if (rep.pattern instanceof RegExp) return rep.pattern.source.replace(/\\(.)/g, "$1");
  return typeof rep.pattern === "string" ? rep.pattern : "";
}

function replacementsOf(patch) {
  if (Array.isArray(patch.replacements)) return patch.replacements;
  return (patch.patterns ?? []).map((pat) => ({ pattern: pat, replace: patch.replace }));
}

/** 从锚点里挑出「够特别」的片段，用来在宿主里找它到底搬去哪了。 */
function tokensOf(pattern) {
  const text = patternText({ pattern });
  const out = new Set();
  for (const m of text.match(STRING) || []) out.add(m);
  for (const m of text.match(IDENT) || []) out.add(m);
  text.split("\n").forEach((line) => {
    const t = line.trim();
    if (t.length >= 8 && /[(){};=]/.test(t)) out.add(t);
  });
  return [...out];
}

function scoreLine(line, tokens) {
  let score = 0;
  for (const token of tokens) if (line.includes(token)) score += token.length >= 12 ? 2 : 1;
  return score;
}

/** 在文件里找最像"旧锚点新落点"的行，返回 ±3 行上下文。 */
export function findCandidates(text, pattern, limit = 3) {
  const tokens = tokensOf(pattern);
  if (tokens.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const scored = [];
  for (let i = 0; i < lines.length; i += 1) {
    const score = scoreLine(lines[i], tokens);
    if (score > 0) scored.push({ line: i + 1, score });
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line);
  const picked = [];
  for (const hit of scored) {
    // 相邻行合并，别把同一处的上下文报三遍。
    if (picked.some((p) => Math.abs(p.line - hit.line) <= 3)) continue;
    const from = Math.max(1, hit.line - 3);
    const to = Math.min(lines.length, hit.line + 3);
    picked.push({
      line: hit.line,
      score: hit.score,
      from,
      to,
      snippet: lines.slice(from - 1, to).join("\n"),
    });
    if (picked.length >= limit) break;
  }
  return picked;
}

function keyPaths(aiBase, key) {
  const files = core.targetFiles(aiBase);
  const val = files[key];
  if (val == null || val === "") return [];
  const list = Array.isArray(val) ? val : [val];
  return list.filter((fp) => fp && fs.existsSync(fp));
}

/** 逐条补丁的漂移诊断：状态、逐文件结论、每条锚点的命中数与候选落点。 */
export async function diagnosePatches(aiBase, { only = [], verbose = false } = {}) {
  const status = await core.patchStatus(aiBase);
  const overrides = readOverrides();
  const rows = [];
  for (const patch of core.ALL_PATCHES) {
    const s = status[patch.id];
    if (only.length > 0 && !only.includes(patch.id)) continue;
    if (only.length === 0 && (s === "applied" || s === "already" || s === "na" || s === "off")) continue;
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    const keyRows = [];
    const anchors = [];
    for (const key of keys) {
      const fps = keyPaths(aiBase, key);
      if (fps.length === 0) {
        keyRows.push({ key, path: "", status: "missing" });
        continue;
      }
      for (const fp of fps) {
        let text = "";
        try {
          text = fs.readFileSync(fp, "utf8");
        } catch (e) {
          keyRows.push({ key, path: fp, status: `unreadable:${e?.code || e}` });
          continue;
        }
        keyRows.push({ key, path: fp, status: core.filePatchOutcome(text, patch, fp) });
        replacementsOf(patch).forEach((rep, index) => {
          const pattern = patternText(rep);
          if (!pattern) return;
          const hits = rep.pattern instanceof RegExp
            ? (text.match(new RegExp(rep.pattern.source, rep.pattern.flags.replace("g", "") + "g")) || []).length
            : text.split(pattern.replace(/\r\n/g, "\n")).length - 1;
          if (hits > 0) return;
          const candidates = findCandidates(text, rep.pattern);
          anchors.push({
            key,
            path: fp,
            index,
            firstLine: pattern.split("\n")[0].trim().slice(0, 120),
            hits,
            candidates,
          });
        });
      }
    }
    const row = {
      id: patch.id,
      name: patch.name,
      status: s,
      optional: patch.optional === true,
      overridden: Boolean(patch.overridden || overrides[String(patch.id)]),
      files: keyRows,
    };
    if (verbose || s === "drifted" || s === "pattern_not_found" || s === "pending") row.anchors = anchors;
    rows.push(row);
  }
  return rows;
}

export function formatDiagnose(rows) {
  if (rows.length === 0) return "没有需要处理的补丁 / nothing to diagnose";
  const out = [];
  for (const row of rows) {
    out.push(`[#${row.id}] ${row.name} — ${row.status}${row.optional ? " (optional)" : ""}${row.overridden ? " (已重锚)" : ""}`);
    for (const f of row.files) out.push(`    ${f.status.padEnd(10)} ${f.key}  ${f.path || "(缺失)"}`);
    for (const a of row.anchors || []) {
      out.push(`    ✗ 锚点[${a.index}] 0 命中：${a.firstLine}`);
      for (const c of a.candidates) {
        out.push(`        候选 L${c.line} (score ${c.score})：`);
        for (const line of c.snippet.split("\n")) out.push(`          ${line}`);
      }
      if (a.candidates.length === 0) out.push("        没有相似片段 —— 这段代码可能已被官方删除或搬去别的文件");
    }
    out.push("");
  }
  return out.join("\n");
}

/** 把宿主里 L(from..to) 的原文钉成该锚点的新 pattern。 */
export function reanchorPatch(aiBase, patchId, index, from, to) {
  const patch = core.ALL_PATCHES.find((p) => p.id === patchId);
  if (!patch) throw new Error(`没有 #${patchId} 这条补丁`);
  const reps = replacementsOf(patch);
  if (index < 0 || index >= reps.length) throw new Error(`#${patchId} 只有 ${reps.length} 条锚点（0..${reps.length - 1}）`);
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  const fps = keys.flatMap((key) => keyPaths(aiBase, key));
  if (fps.length === 0) throw new Error(`#${patchId} 的目标文件不存在，无法重锚`);
  // 多文件补丁：默认取第一条锚点命中的那个文件；重锚只对该文件生效。
  for (const fp of fps) {
    const text = fs.readFileSync(fp, "utf8");
    const lines = text.split(/\r?\n/);
    if (from < 1 || to < from || to > lines.length) {
      throw new Error(`行号越界：文件共 ${lines.length} 行，收到 ${from}-${to}`);
    }
    const snippet = lines.slice(from - 1, to).join("\n");
    writeOverride(undefined, patchId, index, snippet, { at: new Date().toISOString(), source: fp, lines: `${from}-${to}` });
    return { patchId, index, file: fp, lines: `${from}-${to}`, snippet };
  }
  throw new Error(`#${patchId} 没有可读的目标文件`);
}

export function reanchorClear(patchId, index) {
  return clearOverride(undefined, patchId, index);
}

export function overrideFile() {
  return path.join(core.findDshHome(), "dsh-purge", "anchor-overrides.json");
}
