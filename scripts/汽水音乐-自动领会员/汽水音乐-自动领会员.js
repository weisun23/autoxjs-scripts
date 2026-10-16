// ==================== 汽水音乐 · 自动领会员 ====================
// 项目主页：https://github.com/weisun23/autoxjs-scripts
// 开源协议：MIT
//
// 用途
//   自动观看汽水音乐「我的 → 继续领」的激励视频，逐日解锁畅听时长 / 会员。
//
// 架构
//   单层状态轮询：每轮判定一次界面状态，只执行一个动作，随即重新判定。
//   无嵌套循环，因此不存在「进去出不来」的结构性风险。
//
// 平台
//   AutoX.js / Auto.js（Rhino 引擎），配置来源自动适配 Hamibot 与 AutoX，见下方 LOCAL_ENV。
//
// 语法约束
//   Rhino 对 ES6 支持不完整，全脚本只用 var 和 function，不要改成 let / const / 箭头函数。
//
// 免责
//   仅供学习交流。本脚本通过无障碍服务模拟人工点击，可能违反目标应用的用户协议，
//   由此产生的账号限制等风险由使用者自行承担。请勿用于商业用途。

// -------------------- 0. 本地配置（AutoX / Auto.js 用户改这里） --------------------
//
// Hamibot 用户：无需改动本段，在控制台添加同名配置项即可，控制台优先。
// AutoX / Auto.js 用户：没有 hamibot.env 这个对象，请直接改下面的值。
//
// 留空字符串表示「不设置」，此时用各项的内置默认值。

var LOCAL_ENV = {
    maxAdWaitSec: '',       // 单条广告最长等待（秒），默认 90，范围 20-300
    maxRunMinutes: '',      // 总运行时长上限（分钟），默认 60，范围 1-480
    maxAdCount: '',         // 最多观看广告条数，默认 30，范围 1-200
    selftest: '',           // 填 '1' 只跑内置自检，不操作界面
    entryMissGiveUp: ''     // 连续几次导航找不到入口就判定额度领完并退出，默认 2，范围 1-20
};

// -------------------- 1. 配置 --------------------

/**
 * 读取配置项原始值。优先 hamibot.env（Hamibot 控制台），
 * 回退到 LOCAL_ENV（AutoX / Auto.js）。
 * 两个平台共用一份代码，无需分别维护。
 */
function readEnv(key) {
    try {
        if (typeof hamibot !== 'undefined' && hamibot.env) {
            var v = hamibot.env[key];
            if (v !== null && v !== undefined && v !== '') return v;
        }
    } catch (e) { /* 非 Hamibot 环境，回退 */ }

    try {
        if (LOCAL_ENV && LOCAL_ENV[key] !== undefined) return LOCAL_ENV[key];
    } catch (e) { /* 忽略 */ }

    return null;
}

// 自检模式：配置 selftest=1 时只跑纯函数断言，不碰界面
var SELFTEST = (readEnv('selftest') === '1');

/**
 * 读取整数配置项。
 * 控制台传入的值一律是字符串，需转换；超出范围则钳制到边界并告警。
 */
function readInt(key, fallback, min, max) {
    var raw = readEnv(key);

    if (raw === null || raw === undefined || raw === '') {
        return fallback;
    }

    var n = parseInt(raw, 10);
    if (isNaN(n)) {
        logWarn('配置项 ' + key + ' 的值「' + raw + '」不是数字，使用默认值 ' + fallback);
        return fallback;
    }
    if (n < min) {
        logWarn('配置项 ' + key + ' 的值 ' + n + ' 小于下限 ' + min + '，已钳制为 ' + min);
        return min;
    }
    if (n > max) {
        logWarn('配置项 ' + key + ' 的值 ' + n + ' 大于上限 ' + max + '，已钳制为 ' + max);
        return max;
    }
    return n;
}

// 注意：readInt 在下方 CONFIG 初始化时即被调用，那时 logWarn 的定义还在后面。
// JavaScript 的函数声明提升保证这可行——函数声明在脚本解析阶段就已生效。
var CONFIG = {
    maxAdWaitSec: readInt('maxAdWaitSec', 90, 20, 300),      // 单条广告最长等待（秒）
    maxRunMinutes: readInt('maxRunMinutes', 60, 1, 480),     // 总运行时长上限（分钟）
    maxAdCount: readInt('maxAdCount', 30, 1, 200),           // 最多观看广告条数
    pollIntervalMs: 800,                                      // 轮询间隔，内部值
    pollJitterMs: 200,                                        // 轮询抖动幅度
    unknownRoundLimit: 15,                                    // 连续无匹配轮数上限
    clickRetryLimit: 2,                                       // 同一动作重复无效的次数上限
    finishRetryLimit: 8,                                      // 收尾时找不到退出按钮的重试上限
    hardOvertimeMin: 5,                                       // 超出时长上限多少分钟后强制结束
    adDurationSec: readInt('adDurationSec', 35, 10, 180),     // 预期广告时长，到点后尝试点右上角
    adDurationStepSec: 5,                                     // 点早了（弹出中断弹窗）时的加时步长
    offTrackGiveUpLimit: 2,                                   // 累计几次独立跑偏后认输退出（每次离开汽水音乐算一次）

    // --- 导航相关 ---
    appLaunchWaitMs: 6000,   // launchApp 后等待界面稳定的时间
    navRetryLimit: 3,        // 「我的」页签导航重试次数
    scrollRoundsToFind: 3,   // 找任务入口时最多向上滚动几次

    // --- 任务入口消失（额度领完）---
    // 入口消失时，UNKNOWN 的恢复逻辑会 back() → 重启 App 无限找入口。
    // 这两个参数给「确认入口确实没了」提供出口。
    noEntryGraceRounds: 5,   // 在汽水音乐里看不到入口时，先宽容几轮（广告页起来有延迟）
    entryMissGiveUp: readInt('entryMissGiveUp', 2, 1, 20),   // 连续几次完整导航仍找不到入口，判定入口已消失

    // --- 广告顶栏 ---
    // 顶栏按钮的 bounds 高度会塌缩成 0（实测 [619,91,1036,91]），
    // 拿不到真实中心。此偏移用于把点击位置从塌缩的 top 下移到可见的按钮区域。
    topBarClickOffsetY: 40
};

// -------------------- 2. 日志 --------------------

function nowStr() {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function logInfo(msg) {
    log('[' + nowStr() + '] ' + msg);
}

function logWarn(msg) {
    log('[' + nowStr() + '] ⚠ ' + msg);
}

// -------------------- 3. 控件查找 --------------------

// 每个候选项是「返回选择器的函数」，调用时才构造。
// 选择器实例一旦构造就绑定了查找时机，跨轮复用可能拿到过期结果。
// 三路候选（text / desc / 正则）的理由：广告 SDK 的按钮有时只有
// contentDescription 而无 text，文案里也常夹空格或全角字符。
// ⚠ AutoX.js 的 textMatches / descMatches 是「整串匹配」语义（已在真机实测确认）：
//   descMatches(/\d+秒后可领取奖励/)   对 "11秒后可领取奖励，关闭，按钮" 返回 false
//   descMatches(/\d+秒后可领取奖励.*/) 才返回 true
// 所以凡是用正则匹配「前缀固定、后面还有文案」的控件，尾部一律加 .*。
var SEL = {
    // 注意：以下正则一律用 ^...$ 锚定。
    // 广告顶栏的 contentDescription 形如「13秒后可领取奖励，关闭，按钮」，
    // 非锚定的 /领取\s*奖励/ 会命中它，导致广告刚播放就被误判成奖励弹窗乱点。
    继续观看: [
        function () { return text('继续观看'); },
        function () { return desc('继续观看'); },
        function () { return textMatches(/^继续\s*观看$/); },
        function () { return descMatches(/^继续\s*观看$/); }
    ],
    领取奖励: [
        function () { return text('领取奖励'); },
        function () { return desc('领取奖励'); },
        function () { return textMatches(/^领取\s*奖励$/); },
        function () { return descMatches(/^领取\s*奖励$/); }
    ],
    领取成功: [
        // 实测：倒计时归零后，顶栏按钮的 contentDescription 变成「领取成功，关闭，按钮」。
        // 注意 descMatches 是整串匹配（已实测），尾部必须用 .* 吃掉「，关闭，按钮」。
        function () { return desc('领取成功，关闭，按钮'); },
        function () { return descMatches(/^领取成功.*/); },
        function () { return text('领取成功'); },
        function () { return textMatches(/^领取\s*成功.*/); },
        function () { return descMatches(/^领取\s*成功.*/); }
    ],
    坚持退出: [
        function () { return text('坚持退出'); },
        function () { return desc('坚持退出'); },
        function () { return textMatches(/坚持\s*退出/); }
    ],
    更多直播: [
        function () { return textContains('更多直播'); },
        function () { return descContains('更多直播'); }
    ],
    任务入口: [
        function () { return textContains('继续领'); },
        function () { return textContains('领时长'); },
        function () { return descContains('继续领'); },
        function () { return descContains('领时长'); }
    ]
};

/**
 * 会员成长弹窗的标记文案。
 *
 * 为什么不用 Activity 判定：实测该弹窗弹出时 currentActivity() 会返回
 * 「android.app.Dialog」、currentPackage() 返回「miui.systemui.plugin」，
 * 跟弹窗真实的 Activity（AnimatedCommercialSheetDialog）完全对不上。
 * 但它的 contentDescription 稳定可见，所以以内容为准、Activity 为辅。
 *
 * 「第N天畅听」「再看N个提前领」只在这个弹窗上出现（主页卡片用的是 text
 * 且文案为「再看N次领第M天畅听」，与此不同）。
 */
SEL.成长弹窗 = [
    function () { return descMatches(/第\d+天畅听/); },
    function () { return descMatches(/再看\d+个提前领/); }
];

/**
 * 广告顶栏的实时倒计时。穿山甲 SDK 把秒数写进 contentDescription，
 * 形如「13秒后可领取奖励，关闭，按钮」。有它就精确等待，不必盲猜广告时长。
 */
SEL.倒计时 = [
    function () { return descMatches(/\d+\s*秒后可领取奖励.*/); },
    function () { return textMatches(/\d+\s*秒后可领取奖励.*/); }
];

/**
 * 底部导航「我的」页签。
 * 单独成组而不用 text('我的') 裸查：页面内容里也可能出现同名字样，
 * 调用方会用 bounds 过滤出底部区域，避免点错。
 */
SEL.我的页签 = [
    function () { return text('我的'); },
    function () { return desc('我的'); }
];

/**
 * 「我的」页面上的会员任务入口文案。
 * 实测为「继续领」，领满后文案可能变成「领时长」，
 * 另留「立即领取」「去领取」两个变体兜底。
 */
SEL.任务卡片 = [
    function () { return textContains('继续领'); },
    function () { return descContains('继续领'); },
    function () { return textContains('领时长'); },
    function () { return descContains('领时长'); },
    function () { return textContains('立即领取'); },
    function () { return textContains('去领取'); }
];

/**
 * 按候选顺序查找控件，第一个命中即返回。
 * timeoutMs 为 0 时只查一遍（用于状态判定）；大于 0 时轮询重试（用于确认动作结果）。
 */
function findAny(candidateFns, timeoutMs) {
    var deadline = new Date().getTime() + (timeoutMs || 0);
    do {
        for (var i = 0; i < candidateFns.length; i++) {
            var found = null;
            try {
                found = candidateFns[i]().findOnce();
            } catch (e) {
                found = null;    // 无障碍服务偶发异常，跳过该候选继续
            }
            if (found) return found;
        }
        if (timeoutMs > 0) sleep(200);
    } while (new Date().getTime() < deadline);
    return null;
}

// 只判断存在性。必须用 findOnce 而非 findOne(timeout)：
// 状态判定需要即时结果，findOne 找不到会阻塞到超时，
// 多条判定叠起来一轮就能耗掉几十秒。
function existsAny(candidateFns) {
    return findAny(candidateFns, 0) !== null;
}

/**
 * 三级降级点击：控件自身 → 向上找可点击父节点 → 控件 bounds 中心点。
 * 很多广告按钮的文本节点本身不可点击，真正的点击目标是父容器，故有二级。
 * 三级的坐标来自控件真实位置，与屏幕分辨率无关。
 */
function clickSmart(target, label) {
    if (!target) {
        logWarn('clickSmart 收到空控件：' + label);
        return false;
    }

    try {
        if (target.clickable && target.clickable() && target.click()) {
            logInfo('点击「' + label + '」（控件自身）');
            return true;
        }
    } catch (e) { /* 落到二级 */ }

    try {
        var cur = target.parent();
        for (var i = 0; cur && i < 5; i++) {
            if (cur.clickable && cur.clickable() && cur.click()) {
                logInfo('点击「' + label + '」（第 ' + (i + 1) + ' 层父节点）');
                return true;
            }
            cur = cur.parent();
        }
    } catch (e) { /* 落到三级 */ }

    try {
        var b = target.bounds();
        if (click(b.centerX(), b.centerY())) {
            logInfo('点击「' + label + '」（坐标 ' + b.centerX() + ',' + b.centerY() + '）');
            return true;
        }
    } catch (e) { /* 全部失败 */ }

    logWarn('点击「' + label + '」三级降级全部失败');
    return false;
}

// -------------------- 4. 状态判定 --------------------

var APP_NAME = '汽水音乐';
var APP_PKG = null;                              // 启动时动态获取，不硬编码

// 包名兜底常量。AutoX.js 的 getPackageName(应用名) 是遍历已安装应用、
// 比对 applicationInfo.loadLabel() 实现的；Android 11 的包可见性限制会让
// getInstalledPackages() 漏掉汽水音乐（实测 319 个包里 0 个含 luna），
// 于是按应用名查询会时灵时不灵。而按包名 getPackageInfo 是可靠的。
// 所以主用按名查询，失败则回退到这个常量，且回退前先验证它确实装着。
var APP_PKG_FALLBACK = 'com.luna.music';
var AD_ACTIVITY_KEY = 'ExcitingVideoActivity';   // 激励视频页 Activity 特征

// 会员成长弹窗。实测是独立 Activity，内部由 WebView 渲染：
// 无障碍树里只剩 4 个 desc 节点，「解锁第N天畅听」这类按钮完全抓不到，
// 因此只能靠 Activity 名判定状态、按固定比例点右上角关闭。
var SHEET_ACTIVITY_KEY = 'AnimatedCommercialSheetDialog';

/**
 * 动态获取汽水音乐包名。失败返回 null，此时跑偏判定降级为不启用，
 * 避免用猜测值把正常页面误判成跑偏而反复重启 App。
 */
function isPackageInstalled(pkgName) {
    try {
        context.getPackageManager().getPackageInfo(pkgName, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function resolveAppPkg() {
    // 优先按应用名查（换机型/换渠道包时这步能自动适配）
    var pkg = null;
    try {
        pkg = getPackageName(APP_NAME);
    } catch (e) {
        pkg = null;
    }
    if (pkg) {
        logInfo('已获取 ' + APP_NAME + ' 包名：' + pkg);
        return pkg;
    }

    // 按名查不到（Android 11 包可见性限制，实测会时灵时不灵）则回退常量。
    // 回退前必须验证该包真的装着，否则跑偏判定会把正常界面全误判成跑偏。
    if (isPackageInstalled(APP_PKG_FALLBACK)) {
        logWarn('按应用名未能解析包名，回退到常量 ' + APP_PKG_FALLBACK + '（已验证已安装）');
        return APP_PKG_FALLBACK;
    }

    logWarn('未能获取 ' + APP_NAME + ' 包名，跑偏判定将不启用');
    return null;
}

/**
 * 采集本轮判定所需的界面上下文。
 * 集中读取的理由：currentPackage() 和 currentActivity() 都是跨进程调用，
 * 一轮内多次读既慢又可能拿到不一致的快照。
 */
function refreshCtx() {
    var pkg = null;
    var act = '';
    try { pkg = currentPackage(); } catch (e) { pkg = null; }
    try { act = currentActivity() || ''; } catch (e) { act = ''; }
    return {
        pkgName: pkg,
        inAdActivity: act.indexOf(AD_ACTIVITY_KEY) >= 0,
        inSheetDialog: act.indexOf(SHEET_ACTIVITY_KEY) >= 0
    };
}

var STATE = {
    INTERRUPT_DIALOG: 'INTERRUPT_DIALOG',   // 中断弹窗：再看X秒得奖励 / 继续观看 / 坚持退出
    REWARD_DIALOG: 'REWARD_DIALOG',         // 奖励弹窗：领取奖励 / 坚持退出
    AD_DONE: 'AD_DONE',                     // 倒计时结束，右上角出现「领取成功」
    SHEET_DIALOG: 'SHEET_DIALOG',           // 会员成长弹窗（WebView 渲染，按钮不可达）
    LIVE_PAGE: 'LIVE_PAGE',                 // 误入直播页
    AD_PLAYING: 'AD_PLAYING',               // 广告播放中
    TASK_ENTRY: 'TASK_ENTRY',               // 「我的」页面的任务入口
    NO_ENTRY: 'NO_ENTRY',                   // 在汽水音乐里，但看不到任务入口（可能额度已领完）
    OFF_TRACK: 'OFF_TRACK',                 // 跑偏到别的 App
    UNKNOWN: 'UNKNOWN'                      // 无法识别
};

/**
 * 判定当前界面状态。判定顺序即优先级，其中两处顺序刻意安排且不可调换：
 *
 * 1. 「继续观看」排第一——中断弹窗浮在广告上时底层 Activity 仍是
 *    ExcitingVideoActivity。若先判 AD_PLAYING，会把弹窗态误判成
 *    「正在播放」而干等到超时。
 * 2. 「领取奖励」排在「领取成功」之前——实测确认奖励弹窗弹出后，
 *    底层的「领取成功」文本仍然可见。若顺序相反，脚本会反复点击
 *    已点过的「领取成功」而卡死原地。
 *
 * ctx 由 refreshCtx() 提供。除控件查询外无副作用，故可在自检中用假 ctx 测试。
 */
function detectState(ctx) {
    if (existsAny(SEL.继续观看)) return STATE.INTERRUPT_DIALOG;

    if (existsAny(SEL.领取奖励)) return STATE.REWARD_DIALOG;

    // 显式排除前两者：两个文本可同时可见，仅靠存在性不足以区分状态
    if (existsAny(SEL.领取成功)) return STATE.AD_DONE;

    if (existsAny(SEL.更多直播)) return STATE.LIVE_PAGE;

    // 成长弹窗盖在主页之上。排在广告页判定之前，
    // 且不能只信 Activity —— 本机弹窗期间 Activity 名是错的。
    if (ctx.inSheetDialog || existsAny(SEL.成长弹窗)) return STATE.SHEET_DIALOG;

    if (ctx.inAdActivity) return STATE.AD_PLAYING;

    if (existsAny(SEL.任务入口)) return STATE.TASK_ENTRY;

    // 包名未知时不做跑偏判定，避免误判
    if (APP_PKG && ctx.pkgName && ctx.pkgName !== APP_PKG) {
        // MIUI 的悬浮层会短暂取代前台包名（弹窗期间实测为 miui.systemui.plugin）。
        // 这不是真的跑偏，不能因此反复重启 App。
        if (ctx.pkgName.indexOf('miui.') === 0 || ctx.pkgName.indexOf('android') === 0) {
            return STATE.UNKNOWN;
        }
        return STATE.OFF_TRACK;
    }

    // 确认在汽水音乐里，但既没有任务入口、也不在广告页/弹窗上。
    //
    // 单独成一类而不是丢给 UNKNOWN：额度领完后入口会消失，
    // 若走 UNKNOWN 的恢复逻辑，就会 back() → 重启 App → 再找 → 再 back()
    // 无限循环（unknownRecoveries 在 else 分支里被清零，永远升不到下一级）。
    if (APP_PKG && ctx.pkgName === APP_PKG) {
        return STATE.NO_ENTRY;
    }

    return STATE.UNKNOWN;
}

// -------------------- 5. 动作执行 --------------------

var STATS = {
    adCount: 0,             // 已完成观看的广告条数（点击「领取成功」即计数）
    startedAt: 0,           // 脚本启动时刻
    blindClicks: 0,         // 盲点兜底触发次数
    recoveries: 0,          // 异常恢复触发次数
    unknownRounds: 0        // 连续无匹配轮数
};

var RUNTIME = {
    finishing: false,           // 收尾标志：已达上限，等当前广告领完奖后退出
    adStateEnteredAt: null,     // 进入 AD_PLAYING 状态的时刻，用于超时判定
    lastAction: null,           // 上一轮执行的动作名
    sameActionCount: 0,         // 同一动作连续执行次数，用于识别点击失效
    exitLoop: false,            // 主循环退出标志
    adTimeoutStrikes: 0,        // 同一条广告的超时次数：1 次试关闭，2 次放弃
    backAttempts: 0,            // 跑偏后连续 back() 次数，超限改用 launchApp
    unknownRecoveries: 0,       // 未知状态恢复次数。独立于 backAttempts，
                                // 因为后者会被主循环在识别出正常状态时清零
    expectAdSec: 0,             // 当前预期广告时长，初始取 adDurationSec，
                                // 每次点早了就加一档，自行收敛到真实时长
    closeTried: false,          // 本条广告是否已尝试过关闭
    countedThisAd: false,       // 本条广告是否已计数，防重复累加
    offTrackCount: 0,           // 累计「独立跑偏事件」次数，超限认输退出（用户在手动干预）
    offTrackEpisodeCounted: false,  // 当前这次连续跑偏是否已计数，防止一次操作被重复累加
    lastCountdownSec: null,     // 上一次记录的倒计时秒数，仅用于避免日志刷屏
    sheetCloseAttempts: 0,      // 成长弹窗关闭尝试次数，用于逐级换坐标
    noEntryRounds: 0,           // 连续处于「看不到入口」状态的轮数
    entryMissCount: 0,          // 连续多少次完整导航都没找到入口
    endReason: null             // 由状态机指定结束原因，优先于入口段的默认值
};

RUNTIME.expectAdSec = CONFIG.adDurationSec;

/** 是否已达上限。达到后不立即退出，置收尾标志走干净的退出路径。 */
function shouldFinish() {
    if (STATS.adCount >= CONFIG.maxAdCount) {
        logInfo('已达条数上限（' + STATS.adCount + '/' + CONFIG.maxAdCount + '），准备收尾');
        return true;
    }
    var elapsedMin = (new Date().getTime() - STATS.startedAt) / 60000;
    if (elapsedMin >= CONFIG.maxRunMinutes) {
        logInfo('已达时长上限（' + elapsedMin.toFixed(1) + '/' + CONFIG.maxRunMinutes + ' 分钟），准备收尾');
        return true;
    }
    return false;
}

/** 记录动作，返回同一动作的连续次数。用于识别「点了没反应」。 */
function trackAction(name) {
    if (RUNTIME.lastAction === name) {
        RUNTIME.sameActionCount++;
    } else {
        RUNTIME.lastAction = name;
        RUNTIME.sameActionCount = 1;
    }
    return RUNTIME.sameActionCount;
}

/** 带抖动的轮询间隔，模拟真人节奏。 */
function pollSleep() {
    var jitter = Math.floor(Math.random() * CONFIG.pollJitterMs * 2) - CONFIG.pollJitterMs;
    var ms = CONFIG.pollIntervalMs + jitter;
    sleep(ms > 200 ? ms : 200);
}

/**
 * 广告页右上角盲点兜底。全脚本唯一的盲点，三重约束：
 *  - 仅在确认处于广告 Activity 时执行（参考实现在正常页面也盲点，等于乱按）
 *  - 不用固定比例点：不同机型状态栏与挖孔高度不同，取右上角区域中心更稳
 *  - 绝不点屏幕正中：广告页正中通常是落地页入口，点下去直接跳应用商店
 */
function blindClickCloseArea(ctx) {
    if (!ctx.inAdActivity) {
        logWarn('非广告页，拒绝盲点');
        return false;
    }
    var x = Math.floor(device.width * 0.91);
    var y = Math.floor(device.height * 0.07);
    STATS.blindClicks++;
    logWarn('盲点右上角关闭区域（' + x + ',' + y + '），累计 ' + STATS.blindClicks + ' 次');
    return click(x, y);
}

/** 按状态执行对应动作。每轮只执行一个动作，随即返回主循环重新判定。 */
function handleState(state, ctx) {
    switch (state) {

        case STATE.INTERRUPT_DIALOG:
            // 中断弹窗有两个来源，必须区别对待：
            //   1) 脚本把「领取成功」点早了 —— 该加时，让兜底路径收敛到真实广告时长
            //   2) 用户自己按了返回键       —— 不该加时，那不是脚本的判断失误
            // closeTried 只在脚本确实点过顶栏关闭按钮后才为真，用它区分。
            if (RUNTIME.closeTried) {
                RUNTIME.expectAdSec += CONFIG.adDurationStepSec;
                if (RUNTIME.expectAdSec > CONFIG.maxAdWaitSec) {
                    RUNTIME.expectAdSec = CONFIG.maxAdWaitSec;
                }
                logInfo('点击过早，预期广告时长上调至 ' + RUNTIME.expectAdSec + ' 秒');
            } else {
                logInfo('出现中断弹窗，但脚本本轮并未点过关闭（多半是用户按了返回），不加时');
            }

            var goOn = findAny(SEL.继续观看, 0);
            if (goOn) {
                clickSmart(goOn, '继续观看');
                // 从头计时并允许再点一次：弹窗打断后广告会继续播
                RUNTIME.adStateEnteredAt = new Date().getTime();
                RUNTIME.closeTried = false;
            }
            trackAction('继续观看');
            break;

        case STATE.REWARD_DIALOG:
            if (RUNTIME.finishing) {
                // 收尾：奖励在点「领取成功」时已到账，此处点「坚持退出」不损失奖励
                var quitTimes = trackAction('收尾退出');
                var quit = findAny(SEL.坚持退出, 0);
                if (quit) {
                    clickSmart(quit, '坚持退出（收尾）');
                    sleep(1500);
                    RUNTIME.exitLoop = true;
                } else if (quitTimes >= CONFIG.finishRetryLimit) {
                    // 不能无限重试：文案变更或图片渲染都会让这里永远找不到按钮
                    logWarn('连续 ' + quitTimes + ' 轮未找到「坚持退出」，直接回桌面结束');
                    home();
                    RUNTIME.exitLoop = true;
                } else {
                    logWarn('收尾时未找到「坚持退出」，第 ' + quitTimes + ' 次重试');
                }
                break;
            } else {
                // 奖励弹窗出现即证明上一条已看完且奖励到账。
                // 「领取成功」抓不到，无法在那里计数，此处才是可靠的计数点。
                if (!RUNTIME.countedThisAd) {
                    STATS.adCount++;
                    RUNTIME.countedThisAd = true;
                    logInfo('已完成第 ' + STATS.adCount + ' 条广告（奖励已到账）');
                }

                // 计数完立刻判上限，不能等主循环下一轮——
                // 下面这一步点「领取奖励」会加载下一条广告，
                // 等下一轮才发现达上限，就白看了一条（实测多花 20 秒）。
                if (shouldFinish()) {
                    RUNTIME.finishing = true;
                    var quitNow = findAny(SEL.坚持退出, 0);
                    if (quitNow) {
                        clickSmart(quitNow, '坚持退出（收尾）');
                        sleep(1500);
                        RUNTIME.exitLoop = true;
                    } else {
                        logWarn('已达上限但未找到「坚持退出」，交给主循环收尾');
                    }
                    break;
                }

                var next = findAny(SEL.领取奖励, 0);
                if (next) {
                    clickSmart(next, '领取奖励（加载下一条）');
                    RUNTIME.adStateEnteredAt = null;
                    RUNTIME.countedThisAd = false;    // 为下一条重置
                    RUNTIME.closeTried = false;
                    RUNTIME.offTrackCount = 0;        // 流程正常推进，清空跑偏计数
                                                      // （不在主循环清，否则永远到不了认输阈值）
                }
            }
            trackAction('奖励弹窗');
            break;

        case STATE.AD_DONE:
            var okBtn = findAny(SEL.领取成功, 0);
            var times = trackAction('领取成功');
            if (okBtn) {
                if (times > CONFIG.clickRetryLimit) {
                    // 连续点击无效说明控件路径失灵，改走盲点
                    logWarn('「领取成功」连续 ' + times + ' 轮点击无效，改用盲点');
                    blindClickCloseArea(ctx);
                } else if (clickTopBarButton(okBtn, '领取成功')) {
                    // 计数交给 REWARD_DIALOG 分支，避免与那里重复累加
                    RUNTIME.closeTried = true;   // 供 INTERRUPT_DIALOG 判断「是不是脚本点早了」
                    RUNTIME.adStateEnteredAt = null;
                    RUNTIME.lastCountdownSec = null;
                }
            }
            break;

        case STATE.SHEET_DIALOG:
            closeSheetDialog();
            trackAction('关闭成长弹窗');
            break;

        case STATE.NO_ENTRY:
            RUNTIME.noEntryRounds++;

            // 宽限期：刚点完「继续领」到广告页真正起来之间，会有几轮
            // 既不在广告页、也看不到入口。这时候动手会把广告打断。
            if (RUNTIME.noEntryRounds <= CONFIG.noEntryGraceRounds) {
                trackAction('等入口出现');
                break;
            }

            // 宽限过后仍找不到，走一次完整导航（拉前台 → 点我的 → 滚动找）
            ensureAtTaskEntry();
            trackAction('找任务入口');
            break;

        case STATE.LIVE_PAGE:
            logWarn('误入直播页，返回');
            back();
            trackAction('退出直播');
            break;

        case STATE.AD_PLAYING:
            if (RUNTIME.adStateEnteredAt === null) {
                RUNTIME.adStateEnteredAt = new Date().getTime();
                RUNTIME.adTimeoutStrikes = 0;
                RUNTIME.closeTried = false;
                logInfo('广告播放中，预计 ' + RUNTIME.expectAdSec + ' 秒后尝试关闭');
                trackAction('等待播放');
                break;
            }

            // 首选：读顶栏实时倒计时。有倒计时就按兵不动，
            // 等它归零后文案变成「领取成功」，由 detectState 切到 AD_DONE 处理。
            // 这样既不会点早（触发中断弹窗），也不会白等固定秒数。
            var leftSec = readCountdownSec();
            if (leftSec !== null) {
                if (leftSec !== RUNTIME.lastCountdownSec) {
                    RUNTIME.lastCountdownSec = leftSec;
                    logInfo('广告倒计时还剩 ' + leftSec + ' 秒');
                }
                trackAction('等待倒计时');
                break;
            }
            RUNTIME.lastCountdownSec = null;

            // 回退：少数广告不暴露倒计时节点，只能按预期时长盲等后点右上角。
            // 点早了会弹中断弹窗，INTERRUPT_DIALOG 分支会救回并自动加时。
            var playedSec = (new Date().getTime() - RUNTIME.adStateEnteredAt) / 1000;
            if (!RUNTIME.closeTried && playedSec >= RUNTIME.expectAdSec) {
                RUNTIME.closeTried = true;
                logInfo('未发现倒计时节点，已播放 ' + playedSec.toFixed(0) + ' 秒，尝试关闭');
                blindClickCloseArea(ctx);
                trackAction('尝试关闭');
                break;
            }

            // 点过一次还留在广告页，说明那一下没生效，等超时兜底
            if (playedSec >= CONFIG.maxAdWaitSec) {
                recoverStuckAd(ctx);
            }
            trackAction('等待播放');
            break;

        case STATE.TASK_ENTRY:
            if (RUNTIME.finishing) {
                logInfo('已回到任务页且处于收尾状态，结束');
                RUNTIME.exitLoop = true;
                break;
            }
            var entry = findAny(SEL.任务入口, 0);
            if (entry) {
                clickSmart(entry, '任务入口');
                RUNTIME.adStateEnteredAt = null;
                sleep(2000);   // 给广告加载留时间
            }
            trackAction('点任务入口');
            break;

        case STATE.OFF_TRACK:
            recoverOffTrack(ctx);
            trackAction('跑偏恢复');
            break;

        case STATE.UNKNOWN:
            STATS.unknownRounds++;
            if (STATS.unknownRounds >= CONFIG.unknownRoundLimit) {
                recoverUnknown(ctx);
            }
            trackAction('未知状态');
            break;
    }
}

// -------------------- 7. 异常恢复 --------------------

/**
 * 广告卡住：在 AD_PLAYING 状态滞留超过 maxAdWaitSec。
 * 分级处理，不无限重试：
 *  第 1 次——试关闭。若因此弹出中断弹窗，下一轮 INTERRUPT_DIALOG 会点「继续观看」救回。
 *  第 2 次——放弃这一条，点「坚持退出」回主流程。
 */
function recoverStuckAd(ctx) {
    RUNTIME.adTimeoutStrikes++;
    STATS.recoveries++;
    logWarn('广告滞留超过 ' + CONFIG.maxAdWaitSec + ' 秒，第 '
        + RUNTIME.adTimeoutStrikes + ' 次恢复尝试');

    if (RUNTIME.adTimeoutStrikes === 1) {
        var ok = findAny(SEL.领取成功, 0);
        if (ok) {
            clickSmart(ok, '领取成功（超时后补点）');
        } else {
            blindClickCloseArea(ctx);
        }
        RUNTIME.adStateEnteredAt = new Date().getTime();   // 重新计时，给一轮机会
        return;
    }

    logWarn('再次超时，放弃当前广告');
    var quit = findAny(SEL.坚持退出, 0);
    if (quit) {
        clickSmart(quit, '坚持退出（放弃卡住的广告）');
    } else {
        back();
    }
    RUNTIME.adStateEnteredAt = null;
    RUNTIME.adTimeoutStrikes = 0;
}

/**
 * 「任务入口连续找不到」的计数与认输判定。纯函数，便于自检。
 *
 * 为什么要单独计数：入口消失后，ensureAtTaskEntry() 每次都要
 * 「拉前台 → 点我的 → 逐屏滚动」走一遍完整流程，一次十几秒。
 * 靠它连续失败来判断「入口确实没了」，比按轮询次数数更贴合真实成本。
 */
function entryMissStep(missCount, limit) {
    var n = missCount + 1;
    return { missCount: n, giveUp: n >= limit };
}

/**
 * 跑偏计数的纯逻辑：输入当前累计次数与「本次连续跑偏是否已计数」，
 * 返回处理后的新值。
 *
 * 抽成纯函数是为了能在自检里断言「一次连续跑偏只计一次」这条规则——
 * 否则一次 HOME 会因为脚本在跑偏状态滞留多轮而被算成好几次。
 */
function offTrackStep(count, episodeCounted) {
    if (episodeCounted) {
        return { count: count, counted: true };
    }
    return { count: count + 1, counted: true };
}

/**
 * 跑偏到别的 App（广告落地页、浏览器、应用商店）。
 * 参考实现完全缺失这部分，被带走后就无限空转。
 * 先 back() 最多两次，仍未回归则重启 App。
 */
function recoverOffTrack(ctx) {
    STATS.recoveries++;
    RUNTIME.backAttempts++;

    // 跑偏期间每一轮轮询都会走到这里，但一次用户操作（比如按一下 HOME）
    // 会在跑偏状态滞留好几轮。若每轮都 +1，按一次 HOME 会被算成 3 次，
    // 认输阈值就完全失真了。所以一次「连续跑偏」只计一次。
    var step = offTrackStep(RUNTIME.offTrackCount, RUNTIME.offTrackEpisodeCounted);
    RUNTIME.offTrackCount = step.count;
    RUNTIME.offTrackEpisodeCounted = step.counted;

    logWarn('检测到跑偏，当前包名：' + ctx.pkgName
        + '（本次跑偏第 ' + RUNTIME.backAttempts + ' 轮，累计 '
        + RUNTIME.offTrackCount + '/' + CONFIG.offTrackGiveUpLimit + ' 次）');

    // 反复被拉回说明用户在手动退出，此时继续 launchApp 就是跟用户抢方向盘。
    // 自救的目的是从广告落地页回来，不是阻止用户离开。
    if (RUNTIME.offTrackCount >= CONFIG.offTrackGiveUpLimit) {
        logWarn('已累计跑偏 ' + RUNTIME.offTrackCount + ' 次（阈值 '
            + CONFIG.offTrackGiveUpLimit + '），判定为用户主动退出，脚本结束');
        RUNTIME.exitLoop = true;
        return;
    }

    if (RUNTIME.backAttempts <= 2) {
        back();
        sleep(1500);
        return;
    }

    logWarn('back() 无效，重新启动 ' + APP_NAME + ' 并导航到任务入口');
    ensureAtTaskEntry();
    RUNTIME.backAttempts = 0;
    RUNTIME.adStateEnteredAt = null;
}

/**
 * 连续多轮无法识别界面。先 back() 试着退出未知页面，
 * 再次达到阈值则重启 App 回到「我的」页面。
 */
function recoverUnknown(ctx) {
    STATS.recoveries++;
    RUNTIME.unknownRecoveries++;
    logWarn('连续 ' + STATS.unknownRounds + ' 轮无法识别界面，第 '
        + RUNTIME.unknownRecoveries + ' 次恢复尝试');

    // 用独立计数器而非 backAttempts：后者会被主循环在识别出正常状态时清零，
    // 那样第二级「重启 App」几乎永远不会触发。
    if (RUNTIME.unknownRecoveries === 1) {
        back();
        sleep(1500);
    } else {
        logWarn('back() 未能恢复，重新启动 ' + APP_NAME + ' 并导航到任务入口');
        ensureAtTaskEntry();
        RUNTIME.unknownRecoveries = 0;
        RUNTIME.adStateEnteredAt = null;
    }
    STATS.unknownRounds = 0;    // 重置，给恢复后的界面重新计数的机会
}

// -------------------- 5a. 广告顶栏读写 --------------------

/**
 * 读取广告顶栏倒计时剩余秒数。没有倒计时节点时返回 null。
 * 冷门广告 SDK 不暴露此节点，调用方需回退到按预期时长盲等。
 */
function readCountdownSec() {
    var n = findAny(SEL.倒计时, 0);
    if (!n) return null;
    var s = '';
    try { s = n.desc() || ''; } catch (e) { s = ''; }
    if (!s) { try { s = n.text() || ''; } catch (e) { s = ''; } }
    var m = /(\d+)\s*秒后可领取奖励/.exec(s);
    if (!m) return null;
    var v = parseInt(m[1], 10);
    return isNaN(v) ? null : v;
}

/**
 * 当前是否盖着会员成长弹窗（独立 Activity 判定，不依赖无障碍树）。
 */
function isSheetDialogOpen() {
    // 内容判定优先：Activity 名在本机不可靠（见 SEL.成长弹窗 的注释）
    if (existsAny(SEL.成长弹窗)) return true;
    try { return (currentActivity() || '').indexOf(SHEET_ACTIVITY_KEY) >= 0; }
    catch (e) { return false; }
}

/**
 * 关闭会员成长弹窗。
 * 弹窗按钮在无障碍树里不可达，只能按固定比例点右上角 ✕。
 * 实测 (0.907W, 0.555H) = (979,1298)@1080x2340 有效；
 * 失败则逐级换备选坐标，避免一直戳同一个死点。
 *
 * 刻意不点「解锁第N天畅听」：措辞含糊，无法排除是付费入口。
 */
function closeSheetDialog() {
    var cands = [
        [0.907, 0.555],   // 实测有效的 ✕ 位置
        [0.930, 0.500],   // 备选：更靠右上
        [0.500, 0.300]    // 最后手段：弹窗外的遮罩区，多数底板弹窗点遮罩即关
    ];
    var i = RUNTIME.sheetCloseAttempts % cands.length;
    var x = Math.floor(device.width * cands[i][0]);
    var y = Math.floor(device.height * cands[i][1]);
    RUNTIME.sheetCloseAttempts++;

    logWarn('检测到会员成长弹窗，第 ' + RUNTIME.sheetCloseAttempts
        + ' 次尝试关闭，点击 (' + x + ',' + y + ')');
    click(x, y);
    sleep(1200);
}

/**
 * 点击广告顶栏的「领取成功」按钮。
 * 该节点的 bounds 高度实测为 0，坐标点必须下移到可见区域，
 * 否则会点到状态栏而不是按钮。
 */
function clickTopBarButton(node, label) {
    var b = node.bounds();
    var h = b.bottom - b.top;
    var x = b.centerX();
    var y = (h >= 10) ? b.centerY() : (b.top + CONFIG.topBarClickOffsetY);
    logInfo('点击「' + label + '」坐标 (' + x + ',' + y + ')'
        + (h >= 10 ? '' : '（节点高度塌缩，已按顶栏偏移下移）'));
    return click(x, y);
}

// -------------------- 5b. 导航到任务入口 --------------------

/**
 * 切到「我的」页签。
 * 底层导航栏的文本节点通常自身不可点击，clickSmart 会自动上溯到可点击父容器。
 * 找不到控件时用坐标兜底：底部四等分，最右侧即「我的」。
 */
function gotoMyTab() {
    var tab = findAny(SEL.我的页签, 0);

    if (tab) {
        var b = tab.bounds();
        // 只在底部导航区认：页面正文里出现「我的」两个字的概率不低
        if (b.top > device.height * 0.8) {
            if (clickSmart(tab, '底部「我的」页签')) return true;
        } else {
            logWarn('找到「我的」但不在底部导航区（top=' + b.top + '），忽略');
        }
    }

    // 坐标兜底只在主界面上用。广告页的底部是广告落地页按钮区，
    // 弹窗页的底部是弹窗自己的按钮，盲点 (0.88W, 0.96H) 会直接点上去——
    // 实测在广告页盲点会把「安全中心」之类的落地页拉起来。
    var act = '';
    try { act = currentActivity() || ''; } catch (e) { act = ''; }
    if (act.indexOf(AD_ACTIVITY_KEY) >= 0 || act.indexOf(SHEET_ACTIVITY_KEY) >= 0) {
        logWarn('当前在广告页或弹窗（' + act + '），放弃「我的」页签坐标兜底');
        return false;
    }

    var x = Math.floor(device.width * 0.88);
    var y = Math.floor(device.height * 0.96);
    logWarn('未定位到「我的」页签控件，坐标兜底 (' + x + ',' + y + ')');
    return click(x, y);
}

/**
 * 在「我的」页面上找任务入口，找不到就向上滚动再找。
 * 会员任务卡片不一定在首屏，滚动是必要的。
 */
function findTaskEntry() {
    for (var i = 0; i < CONFIG.scrollRoundsToFind; i++) {
        var entry = findAny(SEL.任务卡片, 0);
        if (entry) return entry;

        logInfo('任务入口不在当前屏，向上滚动第 ' + (i + 1) + ' 次');
        swipe(device.width * 0.5, device.height * 0.75,
              device.width * 0.5, device.height * 0.35, 500);
        sleep(1200);
    }
    return findAny(SEL.任务卡片, 0);
}

/**
 * 把界面导航到「我的」页面的任务入口。
 * 返回 true 表示任务入口已在屏幕上，主循环可以直接接手。
 *
 * 为什么需要这一步：主循环只认页面上的入口文案，
 * 若启动时停在播放页，它会一直判 UNKNOWN，然后 back()/重启 App 空转。
 */
function ensureAtTaskEntry() {
    // 会员成长弹窗会整个盖住主页，此时无障碍树里既没有任务入口也没有底部页签。
    // 不先关掉它，后面的「点我的」「滚动找入口」全都会打在弹窗上。
    if (isSheetDialogOpen()) {
        logWarn('启动时盖着会员成长弹窗，先关闭');
        closeSheetDialog();
        sleep(1000);
    }

    // 先原地看一眼。这里刻意用 findAny 而不是 findTaskEntry：
    // 后者会滚动，而启动时大概率停在播放页，盲滚既没用又浪费十几秒。
    if (findAny(SEL.任务卡片, 0)) {
        logInfo('任务入口已在屏幕上，无需导航');
        RUNTIME.entryMissCount = 0;
        return true;
    }

    logInfo('未找到任务入口，开始导航：启动应用 → 点「我的」');
    launchApp(APP_NAME);
    sleep(CONFIG.appLaunchWaitMs);

    // 启动之后弹窗才冒出来的情况
    if (isSheetDialogOpen()) {
        logWarn('启动后出现会员成长弹窗，先关闭');
        closeSheetDialog();
        sleep(1000);
    }

    for (var i = 0; i < CONFIG.navRetryLimit; i++) {
        gotoMyTab();
        sleep(2500);
        entry = findTaskEntry();
        if (entry) {
            logInfo('导航成功，已定位任务入口');
            RUNTIME.entryMissCount = 0;
            return true;
        }
        logWarn('第 ' + (i + 1) + '/' + CONFIG.navRetryLimit + ' 次导航未找到任务入口');
    }

    // 走完一整轮「拉前台 → 点我的 → 滚动找」都没命中，记一次失败
    var step = entryMissStep(RUNTIME.entryMissCount, CONFIG.entryMissGiveUp);
    RUNTIME.entryMissCount = step.missCount;

    if (step.giveUp) {
        logWarn('连续 ' + step.missCount + ' 次完整导航都找不到任务入口');
        logInfo('判定「继续领」入口已消失——通常是已达每日次数或总额度上限');
        logInfo('这是正常结束，不再继续寻找入口');
        RUNTIME.endReason = '任务入口已消失（额度领完）';
        RUNTIME.exitLoop = true;
    } else {
        logWarn('第 ' + step.missCount + '/' + CONFIG.entryMissGiveUp
            + ' 次完整导航未找到任务入口，稍后再试一次');
    }
    return false;
}

// -------------------- 6. 主循环 --------------------

/**
 * 单层状态轮询。每轮：采集上下文 → 判定状态 → 执行一个动作 → 睡一小会儿。
 * 无嵌套循环，因此不存在参考实现那种「进入后无法退出」的结构性风险。
 */
function mainLoop() {
    var rounds = 0;
    var lastLoggedState = null;

    while (!RUNTIME.exitLoop) {
        rounds++;

        try {
            if (!RUNTIME.finishing && shouldFinish()) {
                RUNTIME.finishing = true;
            }

            // 硬上限：置 finishing 后仍需状态机走到退出点，若此时广告卡住，
            // AD_PLAYING 会滞留到 maxAdWaitSec 才动作，可能超出时长上限数分钟。
            var overMin = (new Date().getTime() - STATS.startedAt) / 60000
                - CONFIG.maxRunMinutes;
            if (overMin >= CONFIG.hardOvertimeMin) {
                logWarn('超出时长上限 ' + overMin.toFixed(1) + ' 分钟仍未收尾，强制结束');
                home();
                RUNTIME.exitLoop = true;
                break;
            }

            var ctx = refreshCtx();
            var state = detectState(ctx);

            // 只在状态变化时打印，否则 AD_PLAYING 期间会刷屏
            if (state !== lastLoggedState) {
                logInfo('状态：' + state);
                lastLoggedState = state;
            }

            // 识别出正常状态即说明界面健康，清空恢复计数
            if (state !== STATE.UNKNOWN && state !== STATE.OFF_TRACK) {
                STATS.unknownRounds = 0;
                RUNTIME.backAttempts = 0;
                RUNTIME.unknownRecoveries = 0;
                // 已脱离跑偏状态，下一次再跑偏算作新的一次独立事件。
                // 注意 offTrackCount 本身刻意不清零——否则用户反复进出
                // 永远够不到阈值（每次回来都被重置掉）。
                RUNTIME.offTrackEpisodeCounted = false;
            }
            // 离开成长弹窗就重置关闭计数，下次弹出来重新从首选坐标开始
            if (state !== STATE.SHEET_DIALOG) {
                RUNTIME.sheetCloseAttempts = 0;
            }
            // 同理：重新看到入口后，「看不到入口」的轮数清零
            if (state !== STATE.NO_ENTRY) {
                RUNTIME.noEntryRounds = 0;
            }

            handleState(state, ctx);

        } catch (e) {
            // 单轮异常只记日志并继续，不让一次 null.bounds() 崩掉整个脚本
            logWarn('第 ' + rounds + ' 轮异常：' + e);
        }

        pollSleep();
    }

    logInfo('主循环结束，共 ' + rounds + ' 轮');
}

// -------------------- 8. 统计输出 --------------------

/**
 * 打印运行统计。blindClicks 是判断脚本在特定设备上健康度的关键指标：
 * 正常应接近 0（控件查找命中），偏高说明该设备的选择器需要补充候选。
 */
function printStats(reason) {
    var elapsedMin = (new Date().getTime() - STATS.startedAt) / 60000;
    log('========== 运行统计 ==========');
    log('结束原因：' + reason);
    log('观看广告：' + STATS.adCount + ' 条（上限 ' + CONFIG.maxAdCount + '）');
    log('运行时长：' + elapsedMin.toFixed(1) + ' 分钟（上限 ' + CONFIG.maxRunMinutes + '）');
    log('盲点兜底：' + STATS.blindClicks + ' 次');
    log('异常恢复：' + STATS.recoveries + ' 次');
    if (STATS.blindClicks > STATS.adCount) {
        logWarn('盲点次数多于广告条数，说明控件查找在本机命中率偏低，'
            + '建议回报日志以补充选择器候选');
    }
    log('==============================');
}

/**
 * 注册音量上键监听，随时手动中断。
 * 参考实现没有中断口子，只能强杀，走不到统计输出。
 * 需要额外权限，失败时只记日志不阻塞主流程——中断是便利项。
 */
function setupInterrupt() {
    try {
        events.observeKey();
        events.onKeyDown('volume_up', function () {
            logWarn('检测到音量上键，手动中断');
            RUNTIME.exitLoop = true;
        });
        // 音量下键同样作为中断口。只留上键的话，某些机型上键会被音乐 App
        // 或系统抢走；两个键都留着，随手按哪个都能停。
        events.onKeyDown('volume_down', function () {
            logWarn('检测到音量下键，手动中断');
            RUNTIME.exitLoop = true;
        });
        logInfo('已注册中断：按音量上键或音量下键均可随时停止');
    } catch (e) {
        logWarn('音量键监听注册失败（可能缺少按键监听权限），'
            + '此时可退出汽水音乐 ' + CONFIG.offTrackGiveUpLimit + ' 次让脚本自行结束');
    }
}

// -------------------- 9. 自检模式 --------------------

var SELFTEST_PASS = 0;
var SELFTEST_FAIL = 0;

// 失败时不抛异常而是累计，这样一次运行能看到所有失败项，
// 而不是停在第一个失败上。
function assertEq(actual, expected, caseName) {
    if (actual === expected) {
        SELFTEST_PASS++;
        log('  ✓ ' + caseName);
    } else {
        SELFTEST_FAIL++;
        log('  ✗ ' + caseName + ' —— 期望 ' + expected + '，实际 ' + actual);
    }
}

function runSelfTest() {
    log('========== 自检开始 ==========');

    log('[配置读取]');
    assertEq(readInt('__不存在的键__', 42, 1, 100), 42, '缺失键返回默认值');
    assertEq(readInt('__不存在的键__', 7, 1, 100), 7, '缺失键返回另一默认值');

    log('[选择器结构]');
    // 选择器能否匹配真实控件无法离线验证，但结构可以：
    // 每个候选必须是函数，调用后必须返回带 findOnce 方法的对象。
    // 这能挡住「误把选择器实例写进数组」和「拼错 API 名」两类错误。
    var selKeys = ['继续观看', '领取奖励', '领取成功', '坚持退出', '更多直播', '任务入口'];
    for (var si = 0; si < selKeys.length; si++) {
        var k = selKeys[si];
        var arr = SEL[k];
        assertEq(typeof arr, 'object', k + ' 候选表存在');
        assertEq(arr.length > 0, true, k + ' 候选非空');
        var allFn = true;
        var allHasFindOnce = true;
        for (var ci = 0; ci < arr.length; ci++) {
            if (typeof arr[ci] !== 'function') { allFn = false; break; }
            var inst = arr[ci]();
            if (!inst || typeof inst.findOnce !== 'function') { allHasFindOnce = false; break; }
        }
        assertEq(allFn, true, k + ' 每个候选都是函数');
        assertEq(allHasFindOnce, true, k + ' 每个候选可构造出选择器');
    }

    log('[existsAny 行为]');
    // 验证无匹配时即时返回而不阻塞——误用 findOne 会拖垮整个主循环
    var t0 = new Date().getTime();
    var r = existsAny([function () { return text('__绝不存在的文本_zzz__'); }]);
    var elapsed = new Date().getTime() - t0;
    assertEq(r, false, '无匹配时返回 false');
    assertEq(elapsed < 3000, true, '无匹配时不阻塞（耗时 ' + elapsed + 'ms）');

    log('[状态判定优先级]');
    // detectState 依赖 existsAny 查询真实界面，自检时把它替换成受控 stub，
    // 就能精确验证优先级——尤其是「两个文本同时可见」这个真机上难以稳定复现的场景。
    var realExistsAny = existsAny;

    // visible 是「当前屏幕上可见的文案」集合。
    // 按 SEL 的数组引用反查键名，避免依赖选择器内部结构。
    function stubWith(visible) {
        existsAny = function (candidateFns) {
            for (var key in SEL) {
                if (SEL[key] === candidateFns) {
                    return visible.indexOf(key) >= 0;
                }
            }
            return false;
        };
    }

    var fakeCtxInAd = { pkgName: 'x.y.z', inAdActivity: true };
    var fakeCtxNotInAd = { pkgName: 'x.y.z', inAdActivity: false };

    // 中断弹窗盖在广告上：底层 Activity 仍是广告页，但必须判为中断弹窗
    stubWith(['继续观看']);
    assertEq(detectState(fakeCtxInAd), STATE.INTERRUPT_DIALOG, '中断弹窗优先于播放中');

    // 奖励弹窗与「领取成功」同时可见（实测场景）：必须判为奖励弹窗
    stubWith(['领取奖励', '领取成功']);
    assertEq(detectState(fakeCtxInAd), STATE.REWARD_DIALOG, '奖励弹窗优先于领取成功');

    stubWith(['领取成功']);
    assertEq(detectState(fakeCtxInAd), STATE.AD_DONE, '仅领取成功时判为广告完成');

    stubWith(['继续观看', '领取奖励']);
    assertEq(detectState(fakeCtxInAd), STATE.INTERRUPT_DIALOG, '中断弹窗优先于奖励弹窗');

    stubWith([]);
    assertEq(detectState(fakeCtxInAd), STATE.AD_PLAYING, '无文案且在广告页时判为播放中');

    stubWith(['任务入口']);
    assertEq(detectState(fakeCtxNotInAd), STATE.TASK_ENTRY, '任务入口可识别');

    stubWith(['更多直播']);
    assertEq(detectState(fakeCtxInAd), STATE.LIVE_PAGE, '直播页优先于播放中');

    stubWith([]);
    var savedPkg = APP_PKG;
    APP_PKG = 'com.example.qishui';
    assertEq(detectState({ pkgName: 'com.android.chrome', inAdActivity: false }),
        STATE.OFF_TRACK, '包名不符时判为跑偏');

    APP_PKG = null;
    assertEq(detectState({ pkgName: 'com.android.chrome', inAdActivity: false }),
        STATE.UNKNOWN, '包名未知时不判跑偏');

    // 额度领完后任务入口会消失。此时必须判为 NO_ENTRY 而不是 UNKNOWN，
    // 否则会落进 UNKNOWN 的恢复逻辑，无限 back() + 重启 App 找入口。
    APP_PKG = 'com.example.qishui';
    assertEq(detectState({ pkgName: 'com.example.qishui', inAdActivity: false }),
        STATE.NO_ENTRY, '在汽水音乐里看不到入口时判为 NO_ENTRY');
    assertEq(detectState({ pkgName: 'com.example.qishui', inAdActivity: true }),
        STATE.AD_PLAYING, '广告页优先于 NO_ENTRY');
    assertEq(detectState({ pkgName: 'com.other.app', inAdActivity: false }),
        STATE.OFF_TRACK, '别的 App 优先于 NO_ENTRY');
    APP_PKG = savedPkg;

    existsAny = realExistsAny;    // 必须恢复，否则后续逻辑继续走 stub

    log('[超时边界判定]');
    // 恢复动作有 back()/launchApp() 等真实副作用，无法在自检里跑；
    // 但分级判定的边界可以验证——差一错误会让超时永不触发或立刻触发。
    function isStuck(enteredAtMsAgo, limitSec) {
        var enteredAt = new Date().getTime() - enteredAtMsAgo;
        var stuckSec = (new Date().getTime() - enteredAt) / 1000;
        return stuckSec >= limitSec;
    }
    assertEq(isStuck(89000, 90), false, '滞留 89 秒未达 90 秒上限');
    assertEq(isStuck(91000, 90), true, '滞留 91 秒超过 90 秒上限');
    assertEq(isStuck(0, 90), false, '刚进入播放态不判超时');

    log('[收尾判定边界]');
    function wouldFinish(adCount, maxCount) {
        return adCount >= maxCount;
    }
    assertEq(wouldFinish(29, 30), false, '看了 29 条未达 30 条上限');
    assertEq(wouldFinish(30, 30), true, '看满 30 条触发收尾');

    log('[硬超时边界]');
    // 置 finishing 后若广告卡住，状态机可能迟迟走不到退出点，故需硬上限
    function wouldForceStop(elapsedMin, limitMin, hardOverMin) {
        return (elapsedMin - limitMin) >= hardOverMin;
    }
    assertEq(wouldForceStop(62, 60, 5), false, '超时 2 分钟不强制结束');
    assertEq(wouldForceStop(66, 60, 5), true, '超时 6 分钟强制结束');

    log('[收尾重试上限]');
    assertEq(7 >= CONFIG.finishRetryLimit, false, '第 7 轮未达收尾重试上限');
    assertEq(8 >= CONFIG.finishRetryLimit, true, '第 8 轮触发强制回桌面');

    log('[广告时长自适应]');
    // 点早了会弹中断弹窗，此时加一档时长，脚本自行收敛到真实广告时长
    function nextExpect(cur, step, cap) {
        var v = cur + step;
        return v > cap ? cap : v;
    }
    assertEq(nextExpect(35, 5, 90), 40, '首次点早后上调至 40 秒');
    assertEq(nextExpect(40, 5, 90), 45, '再次点早后上调至 45 秒');
    assertEq(nextExpect(88, 5, 90), 90, '上调不超过 maxAdWaitSec 上限');
    assertEq(RUNTIME.expectAdSec, CONFIG.adDurationSec, '初始预期时长取自配置');

    log('[跑偏认输阈值]');
    // 断言从 CONFIG 推导，调整阈值时不必再改这里
    var otLimit = CONFIG.offTrackGiveUpLimit;
    assertEq(otLimit >= 1, true, '阈值至少为 1（当前 ' + otLimit + '）');
    assertEq((otLimit - 1) >= otLimit, false, '差一次仍会尝试恢复（' + (otLimit - 1) + '/' + otLimit + '）');
    assertEq(otLimit >= otLimit, true, '达到阈值即判定用户主动退出（' + otLimit + '/' + otLimit + '）');

    log('[任务入口消失判定]');
    // 入口消失时靠「完整导航连续失败」判断，边界错一就会永远找不到出口
    var emLimit = CONFIG.entryMissGiveUp;
    var em1 = entryMissStep(0, emLimit);
    assertEq(em1.missCount, 1, '第 1 次导航失败计 1 次');
    assertEq(em1.giveUp, (1 >= emLimit), '第 1 次是否认输取决于阈值');
    if (emLimit >= 2) {
        var em2 = entryMissStep(em1.missCount, emLimit);
        assertEq(em2.missCount, 2, '第 2 次导航失败累加到 2 次');
        assertEq(em2.giveUp, true, '达到阈值即判定入口消失并退出');
    }
    var em3 = entryMissStep(0, emLimit);    // 导航成功时会被清零，下次重新从 1 开始
    assertEq(em3.missCount, 1, '清零后重新计数从 1 开始');
    assertEq(entryMissStep(emLimit - 1, emLimit).giveUp, true, '恰好达到阈值即触发');
    assertEq(entryMissStep(Math.max(emLimit - 2, 0), emLimit).giveUp,
        (Math.max(emLimit - 2, 0) + 1 >= emLimit), '未达阈值不触发');

    log('[跑偏计数规则]');
    // 关键回归点：同一次连续跑偏在后续轮次里不得重复计数
    var st1 = offTrackStep(0, false);
    assertEq(st1.count, 1, '第一次跑偏计入 1');
    assertEq(st1.counted, true, '标记为本次已计数');
    var st2 = offTrackStep(st1.count, st1.counted);
    assertEq(st2.count, 1, '同一次跑偏的后续轮次不重复累加');
    var st3 = offTrackStep(st2.count, false);   // 中途回到正常状态后会复位标志
    assertEq(st3.count, 2, '第二次独立跑偏累加到 2');

    log('[配置来源]');
    var hasHamibot = false;
    try { hasHamibot = (typeof hamibot !== 'undefined' && !!hamibot.env); } catch (e) { hasHamibot = false; }
    log('  运行平台：' + (hasHamibot ? 'Hamibot（读控制台配置）' : 'AutoX / Auto.js（读 LOCAL_ENV）'));
    assertEq(readEnv('__不存在的键__') === null, true, '未知键返回 null');

    log('[配置生效值]');
    log('  maxAdWaitSec  = ' + CONFIG.maxAdWaitSec);
    log('  maxRunMinutes = ' + CONFIG.maxRunMinutes);
    log('  maxAdCount    = ' + CONFIG.maxAdCount);

    log('========== 自检结束：通过 ' + SELFTEST_PASS + '，失败 ' + SELFTEST_FAIL + ' ==========');
}

// -------------------- 10. 入口 --------------------

if (SELFTEST) {
    // 自检不碰界面，不需要无障碍服务，故不调 auto.waitFor()
    console.show();
    runSelfTest();
} else {
    console.show();
    auto.waitFor();                 // 等待无障碍服务就绪
    logInfo('脚本启动');
    var onHamibot = false;
    try { onHamibot = (typeof hamibot !== 'undefined' && !!hamibot.env); } catch (e) { onHamibot = false; }
    logInfo('配置来源：' + (onHamibot ? 'Hamibot 控制台' : 'LOCAL_ENV（脚本顶部）'));
    logInfo('生效配置：单条广告最长等待 ' + CONFIG.maxAdWaitSec + ' 秒，'
        + '总时长上限 ' + CONFIG.maxRunMinutes + ' 分钟，'
        + '最多 ' + CONFIG.maxAdCount + ' 条');

    STATS.startedAt = new Date().getTime();
    APP_PKG = resolveAppPkg();
    setupInterrupt();

    var endReason = '正常结束';
    try {
        // 启动应用并导航到「我的」→ 任务入口
        ensureAtTaskEntry();
        mainLoop();
        if (RUNTIME.finishing) endReason = '达到配置上限';
        if (RUNTIME.endReason) endReason = RUNTIME.endReason;   // 状态机指定的原因优先
    } catch (e) {
        endReason = '异常终止：' + e;
        logWarn('主循环抛出异常：' + e);
    }

    printStats(endReason);
}
