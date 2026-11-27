#!/usr/bin/env node
"use strict";

/**
 * forma-reset patcher for Claude Desktop.
 *
 * Modes
 *   --dest <dir>     patch the install at <dir> (a folder that contains claude.exe)
 *   --extract-only   just unpack app.asar into ./work for inspection
 *
 * What it does
 *   1. Extracts resources/app.asar to a scratch tree
 *   2. Drops forma-reset/main.cjs into .vite/build/forma-reset/
 *   3. Appends the main-process hook to .vite/build/index.pre.js
 *   4. Appends the overlay to .vite/build/mainView.js
 *   5. Repacks app.asar (keeping the original unpacked natives unpacked)
 *   6. Backs up the original asar next to it
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const asar = require("@electron/asar");

const HERE = __dirname;
const SRC = path.join(HERE, "src", "forma-reset");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function fail(msg) {
  console.error(`forma-reset patch: ${msg}`);
  process.exit(1);
}

function stripSourceMap(text) {
  return text.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "\n");
}

const MAIN_HOOK = `

/* ---- forma-reset (main process) ---- */
try {
  require("./forma-reset/main.cjs");
} catch (formaResetErr) {
  try {
    process.stderr.write("[forma-reset] main hook failed: " + String(formaResetErr && formaResetErr.message) + "\\n");
  } catch (_) {}
}
`;

const PRELOAD_HOOK = `

/* ---- forma-reset (renderer overlay) ---- */
try {
__FORMA_RESET_PRELOAD__
} catch (formaResetErr) {
  try { console.error("[forma-reset] overlay failed", formaResetErr); } catch (_) {}
}
`;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    ensureDir(to);
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

/**
 * Claude Desktop ships with two Electron fuses enabled that make a patched
 * app.asar unloadable:
 *   [4] EnableEmbeddedAsarIntegrityValidation
 *   [5] OnlyLoadAppFromAsar
 * Flip both to disabled directly in the fuse wire so the patched asar loads.
 */
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const FUSE_DISABLE = 0x30;

function patchFuses(exePath) {
  if (!fs.existsSync(exePath)) return false;
  const buf = fs.readFileSync(exePath);
  const at = buf.indexOf(Buffer.from(FUSE_SENTINEL, "latin1"));
  if (at < 0) {
    console.warn("  fuses: sentinel not found, skipping");
    return false;
  }
  const count = buf[at + FUSE_SENTINEL.length + 1];
  const base = at + FUSE_SENTINEL.length + 2;
  if (count < 6) {
    console.warn(`  fuses: unexpected wire length ${count}, skipping`);
    return false;
  }
  let changed = false;
  for (const idx of [4, 5]) {
    if (buf[base + idx] !== FUSE_DISABLE) {
      buf[base + idx] = FUSE_DISABLE;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(exePath, buf);
    console.log("  fuses: asar integrity + asar-only loading disabled");
  } else {
    console.log("  fuses: already patched");
  }
  return true;
}

// The fetch hook lives inside a template literal in preload.js, so `node --check`
// cannot see it. A stray newline or backslash then ships code that throws at
// runtime and silently disables every tool. Compile it during the build instead.
function assertHookParses(overlay) {
  const marker = "var hookCode = `";
  const start = overlay.indexOf(marker);
  if (start < 0) fail("hookCode template not found in preload.js");
  let i = start + marker.length;
  let inner = "";
  for (; i < overlay.length; i++) {
    const c = overlay[i];
    if (c === "\\") {
      inner += c + (overlay[i + 1] || "");
      i++;
      continue;
    }
    if (c === "`") break;
    inner += c;
  }
  let code;
  try {
    code = new Function("return `" + inner + "`")();
  } catch (err) {
    fail(`hookCode template does not evaluate: ${err.message}`);
  }
  try {
    new Function(code);
  } catch (err) {
    fail(`hookCode is not valid JavaScript: ${err.message}`);
  }
  if (!/__formaFetchHooked/.test(code)) fail("hookCode lost its install guard");
  console.log(`  hook: compiled ok (${code.length} chars)`);
}

function patchBuildTree(buildDir) {
  const indexPath = path.join(buildDir, "index.pre.js");
  const mainViewPath = path.join(buildDir, "mainView.js");

  if (!fs.existsSync(indexPath)) fail(`missing ${indexPath}`);
  if (!fs.existsSync(mainViewPath)) fail(`missing ${mainViewPath}`);

  // main-process modules — everything except the overlay, which is inlined
  // into the renderer bundle below.
  const modDir = path.join(buildDir, "forma-reset");
  ensureDir(modDir);
  for (const entry of fs.readdirSync(SRC)) {
    if (entry === "preload.js") continue;
    copyRecursive(path.join(SRC, entry), path.join(modDir, entry));
  }

  // main entry hook
  let index = stripSourceMap(fs.readFileSync(indexPath, "utf8"));
  if (!index.includes("forma-reset/main.cjs")) {
    index += MAIN_HOOK;
    fs.writeFileSync(indexPath, index, "utf8");
  }

  // renderer preload hook — inline the overlay so it stays sandbox-safe
  let mainView = stripSourceMap(fs.readFileSync(mainViewPath, "utf8"));
  const overlay = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assertHookParses(overlay);
  if (!mainView.includes("forma-reset (renderer overlay)")) {
    const wrapped = PRELOAD_HOOK.replace("__FORMA_RESET_PRELOAD__", "\n" + overlay + "\n");
    mainView += wrapped;
    fs.writeFileSync(mainViewPath, mainView, "utf8");
  }
}

async function main() {
  const dest = arg("dest", null);
  if (!dest) fail("pass --dest <install dir containing claude.exe>");

  const appDir = path.resolve(String(dest));
  const resDir = path.join(appDir, "resources");
  const asarPath = path.join(resDir, "app.asar");

  if (!fs.existsSync(asarPath)) fail(`no app.asar at ${asarPath}`);

  const backup = path.join(resDir, `app.asar.forma-backup`);
  if (!fs.existsSync(backup)) {
    console.log(`[0/6] backing up original -> ${path.basename(backup)}`);
    fs.copyFileSync(asarPath, backup);
  } else {
    console.log("[0/6] backup already present, keeping it");
  }

  const work = path.join(os.tmpdir(), `forma-reset-work-${Date.now()}`);
  ensureDir(work);

  // Always patch from the pristine backup: patching an already patched asar
  // would keep an outdated overlay forever.
  //
  // The backup is a plain file copy, so its unpacked natives still live in
  // app.asar.unpacked next to it. Stage a correctly named pair so extractAll
  // can resolve them, using a junction instead of copying hundreds of MB.
  const stage = path.join(work, "stage");
  ensureDir(stage);
  const stagedAsar = path.join(stage, "app.asar");
  fs.copyFileSync(backup, stagedAsar);
  const realUnpacked = path.join(resDir, "app.asar.unpacked");
  if (fs.existsSync(realUnpacked)) {
    try {
      fs.symlinkSync(realUnpacked, `${stagedAsar}.unpacked`, "junction");
    } catch {
      copyRecursive(realUnpacked, `${stagedAsar}.unpacked`);
    }
  }

  const tree = path.join(work, "tree");
  ensureDir(tree);
  console.log(`[1/6] extracting ${path.basename(backup)}`);
  asar.extractAll(stagedAsar, tree);
  try {
    fs.unlinkSync(`${stagedAsar}.unpacked`);
  } catch {
    /* junction removal is best-effort; never follows into the real folder */
  }
  fs.rmSync(stage, { recursive: true, force: true });

  const buildDir = path.join(tree, ".vite", "build");
  if (!fs.existsSync(buildDir)) fail(`unexpected asar layout, no .vite/build in ${work}`);

  console.log("[2/6] patching build tree");
  patchBuildTree(buildDir);

  console.log("[2b/6] patching Electron fuses");
  patchFuses(path.join(appDir, "claude.exe"));

  const outAsar = path.join(os.tmpdir(), `forma-reset-app-${Date.now()}.asar`);
  console.log("[4/6] repacking asar");
  await asar.createPackageWithOptions(tree, outAsar, {
    unpack: "**/*.{node,exe,dll}",
    unpackDir: "{node_modules/@ant/claude-native,node_modules/node-pty}",
  });

  console.log("[5/6] swapping asar");
  fs.copyFileSync(outAsar, asarPath);

  // asar.createPackageWithOptions writes newly-unpacked natives next to the
  // temp asar. They must land in the app's own app.asar.unpacked folder or the
  // main process will fail to dlopen them.
  const generatedUnpacked = `${outAsar}.unpacked`;
  if (fs.existsSync(generatedUnpacked)) {
    const targetUnpacked = path.join(resDir, "app.asar.unpacked");
    ensureDir(targetUnpacked);
    copyRecursive(generatedUnpacked, targetUnpacked);
    fs.rmSync(generatedUnpacked, { recursive: true, force: true });
  }

  try {
    fs.unlinkSync(outAsar);
  } catch {
    /* temp asar cleanup is best-effort */
  }

  console.log("[6/6] done");
  console.log(`patched: ${asarPath}`);
  console.log(`backup : ${backup}`);

  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* leave scratch dir behind rather than fail the install */
  }
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
