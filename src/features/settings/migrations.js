/** Ordered historical migrations. Mutates settings, returns whether persistence is needed. */
import { DEFAULT_SETTINGS } from './defaults.js';
import { CARD_ID, DEFAULT_PROMPT_ORDER } from '../../prompt-order.js';

export function migrateSettings(settings) {
    let dirty = false;

    /*
     * v0.33：对话与学习分离（ADR-050）。
     *
     * 学习的语义变了：不再有"主动 / 被动"两套模式，也没有"借下一轮"这回事。
     * 学习一律发生在独立会话里，聊天请求里不再出现任何插件提示词与工具。
     * 因此这一版要搬的东西比较多，全部只搬一次：
     *
     *   blockText / blockCommon / blockActive / blockPassive → learningTask
     *   passiveInterval / passiveKeywords                  → learnInterval / learnKeywords
     *   passiveByDefault                                   → enabledByDefault（取或）
     *   compactPrompt                                      → compactTask
     *   blockPosition / promptInject / toolsResident / toolPrompt → 丢掉
     *
     * 主动段与被动段不再存在，只保留通用段：它原本写的就是"和这一轮学多少无关"的规则。
     * 那段规则讲的是产出方式 / 写到哪 / 怎么写，按 ADR-054 属于特化内容，所以落到
     * learningTask（v0.37 之前它先落在 sessionRules，由下面那段再搬一次）。
     */
    if (Object.hasOwn(settings, 'blockText')) {
        const legacy = typeof settings.blockText === 'string' ? settings.blockText : '';
        if (!Object.hasOwn(settings, 'blockCommon') && legacy.trim()) {
            settings.blockCommon = legacy;
        }
        delete settings.blockText;
        dirty = true;
    }

    if (Object.hasOwn(settings, 'blockCommon')) {
        const legacy = typeof settings.blockCommon === 'string' ? settings.blockCommon : '';
        if (!String(settings.learningTask ?? '').trim() && legacy.trim()) {
            settings.learningTask = legacy;
        }
        delete settings.blockCommon;
        dirty = true;
    }

    for (const legacyKey of ['blockActive', 'blockPassive', 'blockPosition', 'promptInject', 'toolsResident', 'toolPrompt']) {
        if (Object.hasOwn(settings, legacyKey)) {
            delete settings[legacyKey];
            dirty = true;
        }
    }

    /*
     * 原来由 limits.js 管的两个键也跟着"工具日志"一起消失：
     *   traceMaxChars  日志压缩的单行上限（日志本身没了）
     *   learnRounds / learnHistoryChars 是新增的，不需要搬
     * 留着它们只是垃圾：limits.js 的 readLimits 只读自己表里的键，读到也永远不会用。
     */
    if (Object.hasOwn(settings, 'traceMaxChars')) {
        delete settings.traceMaxChars;
        dirty = true;
    }

    for (const [legacyKey, nextKey] of [
        ['passiveInterval', 'learnInterval'],
        ['passiveKeywords', 'learnKeywords'],
    ]) {
        if (Object.hasOwn(settings, legacyKey)) {
            const legacy = settings[legacyKey];
            if (!Object.hasOwn(settings, nextKey) || !settings[nextKey]) {
                settings[nextKey] = typeof legacy === typeof DEFAULT_SETTINGS[nextKey] ? legacy : DEFAULT_SETTINGS[nextKey];
            }
            delete settings[legacyKey];
            dirty = true;
        }
    }

    if (Object.hasOwn(settings, 'passiveByDefault')) {
        // 以前"被动开着"的人，升级后想要的就是"学习模式开着"：两个开关合并成一个
        if (settings.passiveByDefault === true) {
            settings.enabledByDefault = true;
        }
        delete settings.passiveByDefault;
        dirty = true;
    }

    if (Object.hasOwn(settings, 'passiveEnabled')) {
        // v0.26 之前的全局开关，更早的一层；同样只是初值
        if (settings.passiveEnabled === true) {
            settings.enabledByDefault = true;
        }
        delete settings.passiveEnabled;
        dirty = true;
    }

    if (Object.hasOwn(settings, 'compactPrompt')) {
        const legacy = typeof settings.compactPrompt === 'string' ? settings.compactPrompt : '';
        /*
         * v0.33 起这一项改叫 compactUserMessage。两个键同时还在时以后者为准：
         * 它是后来那一版真正给用户编辑的，compactPrompt 只是更早的一份残影。
         */
        const newer = typeof settings.compactUserMessage === 'string' ? settings.compactUserMessage.trim() : '';
        if (!String(settings.compactTask ?? '').trim() && !newer && legacy.trim()) {
            settings.compactTask = legacy;
        }
        delete settings.compactPrompt;
        dirty = true;
    }

    /*
     * v0.36 / v0.37：提示词分成"通用 / 特化"两层（ADR-054）。
     *
     *   learningUserMessage         → learningTask
     *   learnPrompt                 → learningTask 前面（旧的"学习规则"卡排在开场白之前）
     *   compactUserMessage          → compactTask
     *   sessionRules（v0.36 的老值） → learningTask 前面，然后清空这个键
     *
     * 为什么老值一律并进 task 而不是留在通用提示词里：旧版的"规则"写的是产出方式、
     * 写到哪、怎么写，按新分工属于**特化**内容。通用提示词讲的是"你是谁"，
     * 是 v0.37 才有的新东西，所以它从空串（= 默认文本）开始。
     *
     * v0.36 的 `sessionRules` 也要搬，判据是**顺序表里没有 rules 这张卡**——它不可删，
     * 顺序表里出现它就说明已经迁过一遍了。搬完顺便把这张卡插到最前面。
     */
    let promptMoved = false;

    for (const [legacyKey, taskKey] of [
        ['learningUserMessage', 'learningTask'],
        ['compactUserMessage', 'compactTask'],
    ]) {
        if (!Object.hasOwn(settings, legacyKey)) {
            continue;
        }

        const legacy = typeof settings[legacyKey] === 'string' ? settings[legacyKey].trim() : '';
        if (legacy && !String(settings[taskKey] ?? '').trim()) {
            settings[taskKey] = legacy;
            promptMoved = true;
        }
        delete settings[legacyKey];
        dirty = true;
    }

    if (Object.hasOwn(settings, 'learnPrompt')) {
        const legacy = typeof settings.learnPrompt === 'string' ? settings.learnPrompt.trim() : '';
        if (legacy) {
            settings.learningTask = [legacy, String(settings.learningTask ?? '').trim()]
                .filter(Boolean).join('\n\n');
            promptMoved = true;
        }
        delete settings.learnPrompt;
        dirty = true;
    }

    {
        const order = Array.isArray(settings.promptOrder) ? settings.promptOrder.filter(id => typeof id === 'string') : [];
        const hasRulesCard = order.includes(CARD_ID.RULES);
        const staleRules = typeof settings.sessionRules === 'string' ? settings.sessionRules.trim() : '';

        if (!hasRulesCard && (order.length || staleRules || promptMoved)) {
            if (staleRules) {
                settings.learningTask = [staleRules, String(settings.learningTask ?? '').trim()]
                    .filter(Boolean).join('\n\n');
                settings.sessionRules = '';
            }
            // 通用提示词排在目标内容上面：先知道自己是谁，再读到要干什么。
            // 顺序表本来是空的话，这里写出的是默认顺序（空 = 默认，等价）
            const base = order.length ? order : DEFAULT_PROMPT_ORDER;
            settings.promptOrder = [CARD_ID.RULES, ...base.filter(id => id !== CARD_ID.RULES)];
            dirty = true;
        }
    }

    if (Object.hasOwn(settings, 'dropTraces')) {
        // 聊天里不再有插件工具，也就没有"工具日志"要清理
        delete settings.dropTraces;
        dirty = true;
    }

    /*
     * v0.28：三项设置被固定成规则，不再可调（ADR-046）。
     *   moduleWorldbook / moduleDescription  描述存哪儿说了算：card 两个都能写，
     *                                        worldbook 只有那本书能写，没有"关掉一半"这回事
     *   patchEnabled                         card 模式恒暂存（ADR-005）
     *   readScope                            只读可写书：读得到改不了的书会诱发认知冲突
     *
     * 旧值一律丢掉而不是留着当默认：它们描述的是"用户可以关掉一个模块"，
     * 而那个能力已经不存在了，留着只会在别处读到 false 时判出一个不存在的状态。
     */
    for (const legacyKey of ['moduleWorldbook', 'moduleDescription', 'patchEnabled', 'readScope']) {
        if (Object.hasOwn(settings, legacyKey)) {
            delete settings[legacyKey];
            dirty = true;
        }
    }

    return dirty;
}
