/**
 * limits.js · 所有可调数值上限的唯一出口
 *
 * 这些数字原本散在四个模块里（targets 读世界书、tools 写、store 快照槽位、
 * trace 日志截断），设置页一处也碰不到。要做成设置项，如果每个模块继续各写
 * `Number(settings.x) || 常量`，改默认值要改四处，范围校验会各写一套，
 * 读到的脏数据也各有各的处理方式。这里统一收口：
 *
 *   - LIMIT_SPECS  定义每个数字的默认值与可输入范围（设置页据此生成 min/max）
 *   - readLimit    单个值：0 / 空 / 非数字 / 超范围 → 回落默认值，不抛错
 *   - readLimits   一整套：额外保证「软提醒不高于硬上限」
 *
 * 为什么要夹取而不是原样使用：这些值会直接决定"写入被拒还是通过"。
 * 设置文件是能手改的，读到 0 或 9999999 时正确的反应是回到默认值，
 * 而不是让所有写入突然被拒、或者软提醒永远不触发。
 */

/**
 * 每个上限：默认值 + 可输入范围。
 *
 * `min` 是"再小就没有意义"的底线（比如关键词上限至少 1 个，否则新建条目
 * 永远满足不了 ADR-009）；`max` 是"再大就不是限制"的天花板，只防手滑。
 *
 * 顺序与设置页一致：世界书条目 → 角色描述 → 读取返回 → 记录与日志。
 */
export const LIMIT_SPECS = Object.freeze({
    /** 单条世界书正文的软提醒（字）：只在压缩面板里标记该压，不拦截任何写入 */
    softLimitEntry: Object.freeze({ default: 800, min: 100, max: 20000, step: 50 }),
    /** 单条世界书正文的硬上限（字）：写入后整条超过直接拒绝 */
    hardLimitEntry: Object.freeze({ default: 1200, min: 100, max: 40000, step: 50 }),
    /** 单条条目最多保留几个关键词，超出截断（不是拒绝） */
    maxKeywords: Object.freeze({ default: 8, min: 1, max: 50, step: 1 }),
    /** 条目标题字数上限，超出报 TITLE_TOO_LONG */
    titleMaxChars: Object.freeze({ default: 60, min: 4, max: 200, step: 2 }),

    /** 角色描述的软提醒（字）：超过时列进压缩面板（ADR-040） */
    softLimitDesc: Object.freeze({ default: 1600, min: 100, max: 40000, step: 50 }),
    /** 角色描述的硬上限（字）：写入后总长超过直接拒绝 */
    hardLimitDesc: Object.freeze({ default: 2400, min: 100, max: 80000, step: 50 }),

    /** 一次正则读取最多返回几处命中；超出的只报总数 */
    maxMatches: Object.freeze({ default: 10, min: 1, max: 100, step: 1 }),
    /** 单条正文最多返回多少字（角色描述或世界书条目，超出截断并标注） */
    maxReadChars: Object.freeze({ default: 3000, min: 200, max: 40000, step: 100 }),
    /** lore_list 最多列几条标题 */
    listLimit: Object.freeze({ default: 80, min: 5, max: 500, step: 5 }),
    /** 整本书条目数超过这个值就提醒合并 */
    softEntryCount: Object.freeze({ default: 200, min: 10, max: 100000, step: 10 }),
    /** 正则表达式本身的字数上限：超过不是能力问题，是写法问题 */
    patternMaxChars: Object.freeze({ default: 200, min: 20, max: 1000, step: 10 }),
    /** 命中片段前后各显示多少字，0 之外的值才有区分度 */
    matchWindow: Object.freeze({ default: 60, min: 10, max: 400, step: 10 }),

    /** 面板"已写入"保留几条：既是备份槽位数，也是能退几步 */
    loreBackupLimit: Object.freeze({ default: 10, min: 1, max: 50, step: 1 }),
    /** 工具日志单行截断字数 */
    traceMaxChars: Object.freeze({ default: 200, min: 40, max: 2000, step: 10 }),
});

export const LIMIT_KEYS = Object.freeze(Object.keys(LIMIT_SPECS));

/** 默认值表。DEFAULT_SETTINGS 直接铺开它，避免同一批数字存两份 */
export const LIMIT_DEFAULTS = Object.freeze(
    Object.fromEntries(LIMIT_KEYS.map(key => [key, LIMIT_SPECS[key].default])),
);

/**
 * 把一个输入值夹成该上限的合法值。
 *
 * 非正数一律回落默认值而不是夹到 min：0 在这里的意思是"没填 / 清空了"，
 * 把它当成"设成最小值"会让用户以为自己的输入生效了。
 *
 * @param {string} key LIMIT_SPECS 的键
 * @param {unknown} value
 * @returns {number}
 */
export function clampLimit(key, value) {
    const spec = LIMIT_SPECS[key];
    if (!spec) {
        return 0;
    }

    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return spec.default;
    }

    return Math.min(Math.max(Math.round(num), spec.min), spec.max);
}

/**
 * 读一个上限；设置里没有、类型不对、超出范围都按默认值处理。
 * @param {object} settings extension_settings.thrive
 * @param {string} key
 */
export function readLimit(settings, key) {
    return clampLimit(key, settings?.[key]);
}

/**
 * 读整套上限。
 *
 * 软提醒被硬上限封顶：用户可以两边随便填，但"软 > 硬"意味着一条内容在被拒之前
 * 根本不会出现在压缩面板里（面板按软提醒筛，而写入按硬上限拦）。与其在设置页拦住他，
 * 不如在生效时按硬上限算——结果永远自洽，面板上也会把实际生效值写出来。
 *
 * @param {object} settings
 * @returns {Record<string, number>}
 */
export function readLimits(settings) {
    const limits = {};
    for (const key of LIMIT_KEYS) {
        limits[key] = readLimit(settings, key);
    }

    limits.softLimitEntry = Math.min(limits.softLimitEntry, limits.hardLimitEntry);
    limits.softLimitDesc = Math.min(limits.softLimitDesc, limits.hardLimitDesc);

    return limits;
}
