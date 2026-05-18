/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          VEO3 — Secure Build Script                  ║
 * ║  Compile JS → JSC (bytenode) + electron-builder       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Cách dùng:
 *   node build-secure.js             → Build (không publish)
 *   node build-secure.js --publish   → Build + publish lên GitHub
 *
 * Chiến lược bảo vệ:
 *   main.js / server.js / auth.js / updater.js
 *       → compile bằng bytenode → .jsc (V8 bytecode, không decompile được)
 *
 *   automation.js
 *       → obfuscate bằng javascript-obfuscator (vẫn là .js nhưng gần như không đọc được)
 *       → KHÔNG dùng bytenode vì page.evaluate(() => {...}) cần fn.toString()
 *          để serialize function gửi lên Chrome qua CDP
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = __dirname;

// ── Danh sách file compile bytenode ──────────────────────────────────────────
// exports: true  → file export module
// exports: false → file không export, chỉ chạy side-effect
const TARGETS = [
  { src: 'main.js', exports: false },
  { src: 'server.js', exports: false },
  { src: 'auth.js', exports: true },
  { src: 'updater.js', exports: true },
];

// ── Danh sách file obfuscate (không compile bytecode) ─────────────────────────
// Các file này dùng page.evaluate() → cần giữ fn.toString() hoạt động
const OBFUSCATE_TARGETS = [
  'automation.js',
];

// Lưu nội dung gốc để restore sau khi build
const backups = {};

// ── Electron binary path ──────────────────────────────────────────────────────
const electronBin = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
  : path.join(ROOT, 'node_modules', '.bin', 'electron');

// ── Cleanup: xóa temp file + restore source files ────────────────────────────
function cleanup() {
  const runner = path.join(ROOT, '_compile_runner.js');
  if (fs.existsSync(runner)) {
    try { fs.unlinkSync(runner); } catch (_) { }
  }

  for (const [filePath, content] of Object.entries(backups)) {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (e) {
      console.error(`⚠️  Không thể restore: ${path.basename(filePath)}`, e.message);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔒 VEO3 Secure Build');
  console.log('═'.repeat(50));

  // ── PRE-STEP: Inject Auth Integrity Hash vào server.js trước khi compile ──
  // Mục tiêu: bake SHA256 hash của auth.js stub vào server.jsc (bytecode).
  // → Nếu ai giải ASAR và thay auth.js bằng class giả → hash không khớp → app exit(1)
  console.log('\n🔑 PRE-STEP: Injecting auth integrity hash into server.js...\n');

  const serverPath = path.join(ROOT, 'server.js');
  const originalServerJs = fs.readFileSync(serverPath, 'utf-8');

  // Auth stub content là deterministic — khớp với template ở STEP 2 bên dưới
  // auth.js có exports: true → stub là: 'use strict';\nrequire('bytenode');\nmodule.exports = require('./auth.jsc');\n
  const authStubContent = `'use strict';\nrequire('bytenode');\nmodule.exports = require('./auth.jsc');\n`;
  const authStubHash = crypto.createHash('sha256').update(authStubContent).digest('hex');
  console.log(`  ℹ️  Auth stub SHA256: ${authStubHash}`);

  const patchedServerJs = originalServerJs.replace(
    "'__AUTH_STUB_HASH__'",
    `'${authStubHash}'`
  );

  if (patchedServerJs === originalServerJs) {
    console.warn('  ⚠️  Không tìm thấy placeholder __AUTH_STUB_HASH__ trong server.js');
    console.warn('       Hãy thêm: const EXPECTED_HASH = \'__AUTH_STUB_HASH__\'; vào server.js');
  } else {
    // Lưu backup bản GỐC (với placeholder) TRƯỚC khi patch
    // → cleanup() sẽ restore về file gốc có placeholder, không phải bản đã inject hash
    backups[serverPath] = originalServerJs;
    fs.writeFileSync(serverPath, patchedServerJs, 'utf-8');
    console.log(`  ✅  Hash injected vào server.js (sẽ restore về placeholder sau build)`);
  }

  // ── STEP 1: Compile JS → JSC (bytenode) ──────────────────────────────────
  console.log('\n📦 STEP 1: Compiling JS → JSC (Electron V8)...\n');

  const compileRunnerCode = `
'use strict';
const { app } = require('electron');
const bytenode = require('bytenode');
const path = require('path');

const ROOT = ${JSON.stringify(ROOT)};
const TARGETS = ${JSON.stringify(TARGETS)};

app.on('ready', () => {
  let allOk = true;
  for (const t of TARGETS) {
    const input  = path.join(ROOT, t.src);
    const output = path.join(ROOT, t.src.replace('.js', '.jsc'));
    try {
      bytenode.compileFile({ filename: input, output });
      console.log('  ✅  ' + t.src + ' → ' + path.basename(output));
    } catch (e) {
      console.error('  ❌  ' + t.src + ':', e.message);
      allOk = false;
    }
  }
  process.exitCode = allOk ? 0 : 1;
  app.quit();
});
`.trim();

  fs.writeFileSync(path.join(ROOT, '_compile_runner.js'), compileRunnerCode, 'utf-8');

  try {
    execSync(`"${electronBin}" "${path.join(ROOT, '_compile_runner.js')}"`, {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch (e) {
    cleanup();
    console.error('\n❌ Compilation failed — build aborted.');
    process.exit(1);
  }

  try { fs.unlinkSync(path.join(ROOT, '_compile_runner.js')); } catch (_) { }

  // ── STEP 2: Tạo entry loader + stubs (cho các file bytecode) ────────────
  console.log('\n📝 STEP 2: Creating entry loader and stubs...\n');

  fs.writeFileSync(
    path.join(ROOT, 'main.compiled.js'),
    `'use strict';\n// VEO3 Secure Loader — DO NOT EDIT\nrequire('bytenode');\nrequire('./main.jsc');\n`,
    'utf-8'
  );
  console.log('  ✅  main.compiled.js (entry loader)');

  for (const t of TARGETS) {
    const filePath = path.join(ROOT, t.src);
    const jscName = t.src.replace('.js', '.jsc');

    // Backup (b\u1ecf qua n\u1ebfu file n\u00e0y \u0111\u00e3 c\u00f3 trong backups t\u1eeb PRE-STEP \u2014 tr\u00e1nh overwrite b\u1ea3n g\u1ed1c)
    if (!backups[filePath]) {
      backups[filePath] = fs.readFileSync(filePath, 'utf-8');
    }

    const stub = t.exports
      ? `'use strict';\nrequire('bytenode');\nmodule.exports = require('./${jscName}');\n`
      : `'use strict';\nrequire('bytenode');\nrequire('./${jscName}');\n`;

    fs.writeFileSync(filePath, stub, 'utf-8');
    console.log(`  ✅  stub: ${t.src}`);
  }

  // ── STEP 2.5: Obfuscate automation.js (và các OBFUSCATE_TARGETS) ─────────
  console.log('\n🌀 STEP 2.5: Obfuscating JS files...\n');

  let JavaScriptObfuscator;
  try {
    JavaScriptObfuscator = require('javascript-obfuscator');
  } catch (e) {
    cleanup();
    console.error('❌ javascript-obfuscator chưa được cài. Chạy: npm install --save-dev javascript-obfuscator');
    process.exit(1);
  }

  for (const srcFile of OBFUSCATE_TARGETS) {
    const filePath = path.join(ROOT, srcFile);
    const original = fs.readFileSync(filePath, 'utf-8');

    // Backup để restore sau khi build
    backups[filePath] = original;

    try {
      const obfuscated = JavaScriptObfuscator.obfuscate(original, {
        // ── Cơ bản ──────────────────────────────────────────────────────────
        compact: true,
        simplify: true,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,   // QUAN TRỌNG: không đổi tên require/module.exports

        // ── KHÔNG dùng stringArray: true với automation.js ───────────────────
        // stringArray tạo biến _0x... ở module scope (Node.js).
        // Nhưng page.evaluate(fn) serialize fn.toString() rồi chạy trong Chrome context.
        // Chrome không có biến _0x... → "is not defined"
        stringArray: false,

        // ── Số học (an toàn - không tạo external reference) ──────────────────
        numbersToExpressions: true,

        // ── TẮT toàn bộ những thứ gây lỗi ───────────────────────────────────
        controlFlowFlattening: false,  // Phá closure/async
        splitStrings: false,           // Break template literals
        deadCodeInjection: false,
        debugProtection: false,
        selfDefending: false,
        disableConsoleOutput: false,
        domainLock: [],
        sourceMap: false,
      }).getObfuscatedCode();

      fs.writeFileSync(filePath, obfuscated, 'utf-8');
      const origKB = Math.round(original.length / 1024);
      const obfKB = Math.round(obfuscated.length / 1024);
      console.log(`  ✅  obfuscated: ${srcFile} (${origKB}KB → ${obfKB}KB)`);
    } catch (e) {
      cleanup();
      console.error(`\n❌ Obfuscate thất bại: ${srcFile}`, e.message);
      process.exit(1);
    }
  }

  // ── STEP 3: Run electron-builder ─────────────────────────────────────────
  const publishFlag = process.argv.includes('--publish') ? '--publish always' : '';
  console.log(`\n🚀 STEP 3: Running electron-builder ${publishFlag || '(no publish)'}...\n`);

  let buildOk = true;
  try {
    execSync(`npx electron-builder --win --x64 ${publishFlag}`, {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  } catch (e) {
    buildOk = false;
  }

  // ── STEP 4: Restore source files ─────────────────────────────────────────
  console.log('\n🔄 STEP 4: Restoring source files...');
  cleanup();
  console.log('  ✅  Source files restored');

  if (buildOk) {
    console.log('\n' + '═'.repeat(50));
    console.log('✅  Secure build HOÀN TẤT!\n');
  } else {
    console.error('\n❌  electron-builder thất bại (source đã được restore)\n');
    process.exit(1);
  }
}

// Handle Ctrl+C
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

main().catch(e => {
  cleanup();
  console.error('Fatal Error:', e.message);
  process.exit(1);
});