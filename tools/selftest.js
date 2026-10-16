/**
 * 本地验证工具（不需要手机、不需要无障碍）。
 *
 *   node tools/selftest.js                    跑脚本内置自检（纯函数断言）
 *   node tools/selftest.js --sim-no-entry     场景回归：模拟「额度领完、入口消失」
 *                                            断言脚本会干净退出，而不是无限找入口
 *
 * 脚本的 selftest 分支不碰界面，所以能在电脑上直接跑。改完状态机先跑这个，
 * 再去真机验证。退出码 0 表示通过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const MODE = argv.includes('--sim-no-entry') ? 'sim-no-entry' : 'selftest';
const scriptPath = argv.find((a) => !a.startsWith('--')) || path.join(__dirname, '..',
    'scripts', '汽水音乐-自动领会员', '汽水音乐-自动领会员.js');

if (!fs.existsSync(scriptPath)) {
    console.error('找不到脚本: ' + scriptPath);
    process.exit(2);
}

// ---------- AutoX.js 全局桩 ----------
const selectorStub = () => ({
    findOnce: () => null,
    findOne: () => null,
    exists: () => false,
    find: () => ({ size: () => 0, get: () => null }),
});

const g = globalThis;
g.text = selectorStub;
g.desc = selectorStub;
g.textMatches = selectorStub;
g.descMatches = selectorStub;
g.textContains = selectorStub;
g.descContains = selectorStub;

g.__capture = [];
g.log = (s) => { globalThis.__capture.push(String(s)); };
g.console = { show: () => {}, log: g.log, error: () => {} };
g.toast = () => {};
g.random = (a) => a || 0;

// sleep 既用来推进时间，也充当死循环看门狗：正常收尾最多几十次
g.__sleeps = 0;
const SLEEP_BUDGET = 400;
g.sleep = () => {
    if (++globalThis.__sleeps > SLEEP_BUDGET) {
        throw new Error('看门狗触发：sleep 调用超过 ' + SLEEP_BUDGET + ' 次，疑似死循环');
    }
};

g.device = { width: 1080, height: 2340 };
g.click = () => true;
g.press = () => true;
g.swipe = () => true;
g.gesture = () => true;
g.longClick = () => true;
g.back = () => true;
g.home = () => true;
g.launchApp = () => true;
g.context = { getPackageManager: () => ({ getPackageInfo: () => ({ versionName: '0' }) }) };
g.app = { launchPackage: () => true, getPackageName: () => null };
g.events = { observeKey: () => {}, onKeyDown: () => {} };
g.auto = { waitFor: () => {}, service: {} };
g.files = { read: () => '', write: () => {}, append: () => {}, exists: () => false, remove: () => {} };

if (MODE === 'sim-no-entry') {
    // 模拟：汽水音乐已在前台，但「继续领」入口消失（额度领完）。
    // 所有选择器都找不到 → 脚本应连着导航失败两次后干净退出。
    g.getPackageName = () => 'com.luna.music';
    g.currentPackage = () => 'com.luna.music';
    g.currentActivity = () => 'com.luna.biz.main.main.MainActivity';
} else {
    g.getPackageName = () => null;
    g.currentPackage = () => null;
    g.currentActivity = () => '';
}

// ---------- 执行脚本 ----------
let src = fs.readFileSync(scriptPath, 'utf8');
if (MODE === 'selftest') {
    const marker = "var SELFTEST = (readEnv('selftest') === '1');";
    if (src.indexOf(marker) < 0) {
        console.error('找不到 SELFTEST 开关，脚本结构可能变了');
        process.exit(2);
    }
    src = src.replace(marker, 'var SELFTEST = true;');
}

let crashed = null;
try {
    (0, eval)(src);
} catch (e) {
    crashed = e;
}

const out = g.__capture.join('\n');
process.stdout.write(out + '\n\n');

if (crashed) {
    process.stderr.write('❌ 执行中断: ' + (crashed.stack || crashed) + '\n');
    process.exit(1);
}

if (MODE === 'selftest') {
    const fail = /失败\s*(\d+)/.exec(out);
    const pass = /通过\s*(\d+)/.exec(out);
    if (!pass) {
        process.stderr.write('❌ 没找到自检结果\n');
        process.exit(1);
    }
    if (fail && Number(fail[1]) > 0) {
        process.stderr.write('❌ 自检未通过\n');
        process.exit(1);
    }
    process.stdout.write('✅ 本地自检通过（' + pass[1] + ' 项）\n');
} else {
    // 回归断言：入口消失时必须干净收尾，而不是无限找入口
    const checks = [
        ['判定了入口消失', /判定「继续领」入口已消失/.test(out)],
        ['给出了结束原因', /结束原因：任务入口已消失/.test(out)],
        ['主循环已退出', /主循环结束/.test(out)],
        ['没有触发恢复循环', /异常恢复：0 次/.test(out)],
    ];
    let bad = 0;
    for (const [name, ok] of checks) {
        process.stdout.write((ok ? '  ✓ ' : '  ✗ ') + name + '\n');
        if (!ok) bad++;
    }
    if (bad) {
        process.stderr.write('❌ 入口消失场景回归失败\n');
        process.exit(1);
    }
    process.stdout.write('✅ 入口消失场景回归通过\n');
}
