/** tool-catalog.js · Internal tools module; public entry: index.js. */

import { TOOL_NAMES } from './tool-names.js';

import { isBlank } from '../../shared/util.js';

import { guardAction } from './tool-availability.js';

import { handleLoreAdd, handleLoreAppend, handleLoreList, handleLoreRead, handleLoreReplace, handleLoreRewrite } from './lore-handlers.js';

import { handleDescAppend, handleDescRead, handleDescReplace, handleDescRewrite } from './desc-handlers.js';
import { handleStructuredDesc } from './structured-desc-handlers.js';

/** 工具定义表。`{ name, description, parameters, action }`，action 永不 throw */
const DEFS = [];

let built = false;

function define(def) {
    DEFS.push(def);
}

/**
 * 取全部工具定义。第一次调用时建表，之后原样复用。
 *
 * 每个 `action` 都返回 ST 形状的 `{ ok, error?, hint? }`；session-tools.js 负责把它
 * 序列化成工具消息的正文（并保证非空——`role:'tool'` 的内容空掉会让整条消息消失）。
 *
 * @returns {Array<{ name: string, description: string, parameters: object, action: Function }>}
 */
function getToolDefs() {
    if (!built) {
        buildLoreTools();
        buildDescTools();
        buildStructuredTools();
        built = true;
    }
    return DEFS.slice();
}

function buildStructuredTools() {
    for (const format of ['plist', 'alichat']) {
        const label = format === 'plist' ? 'PLists' : 'Ali:Chat';
        const fields = format === 'plist'
            ? {
                key: { type: 'string', description: '分类名，例如角色的性格。' },
                traits: { type: 'array', items: { type: 'string' }, minItems: 1, description: '属性文字数组，例如 kind、hair(red)。' },
            }
            : {
                index: { type: 'integer', minimum: 0, description: '从 0 开始的位置；新增时省略表示追加。插入或删除后以后续返回的位置为准。' },
                question: { type: 'string', description: '访谈问题，可含多行。' },
                answer: { type: 'string', description: '角色的示例回答，体现语气、行动和态度，可含多行。' },
            };
        const descriptions = format === 'plist'
            ? {
                read: '读取 PLists 分类及属性。省略 key 返回整个字典，给 key 只查该分类（含不存在的分类）。',
                add: '向分类加入属性并去重；分类不存在则新建。必须先读取该分类或整个字典。',
                update: '替换已有分类的全部属性；必须先读取该分类或整个字典。',
                delete: '删除已有分类；给 traits 则只删除指定属性。必须先读取该分类或整个字典。',
            }
            : {
                read: '读取 Ali:Chat 问答列表及位置。省略 index 返回全部，给 index 只查该位置。',
                add: '新增一组问答。省略 index 追加，给 index 插入该位置。必须先读取整个列表。',
                update: '替换指定位置的一组问答。必须先读取该位置或整个列表。',
                delete: '删除指定位置的一组问答。必须先读取该位置或整个列表。',
            };
        for (const operation of ['read', 'add', 'update', 'delete']) {
            const name = `${format}_${operation}`;
            const selector = format === 'plist' ? 'key' : 'index';
            const properties = operation === 'read'
                ? { [selector]: fields[selector] }
                : operation === 'delete' && format === 'alichat' ? { index: fields.index } : fields;
            const required = operation === 'read' ? []
                : format === 'plist' ? (operation === 'delete' ? ['key'] : ['key', 'traits'])
                    : operation === 'add' ? ['question', 'answer']
                        : operation === 'delete' ? ['index'] : ['index', 'question', 'answer'];
            define({
                name,
                displayName: `${label} · ${ { read: '读取', add: '新增', update: '修改', delete: '删除' }[operation]}`,
                description: `${descriptions[operation]}仅操作角色描述的专属世界书条目，自动序列化保存。`,
                parameters: { type: 'object', properties, required },
                action: guardAction(name, params => handleStructuredDesc(format, operation, params)),
                formatMessage: () => `${label} ${operation}`,
            });
        }
    }
}

/* ------------------------------------------------------------ 世界书工具 */

function buildLoreTools() {
    define({
        name: TOOL_NAMES.LORE_LIST,
        displayName: '列出世界书条目',
        description: '列出当前可写世界书里已启用的条目，只给标题，不给正文。'
            + '用 pattern 可以按标题或触发关键词过滤。'
            + '这是写之前了解这本书已有什么的第一步；要看某条的正文用 lore_read。',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '正则表达式，匹配标题或触发关键词。省略则列出全部。',
                },
                flags: {
                    type: 'string',
                    description: 'i 忽略大小写、m 多行、s 让 . 匹配换行，可连写如 im。不支持 g。',
                },
                limit: {
                    type: 'number',
                    description: '最多返回几条标题。省略用设置里的默认值。',
                },
            },
        },
        action: guardAction(TOOL_NAMES.LORE_LIST, handleLoreList),
        formatMessage: params => (isBlank(params?.pattern) ? '浏览世界书目录' : `筛选世界书：${params.pattern}`),
    });

    define({
        name: TOOL_NAMES.LORE_READ,
        displayName: '读取世界书条目',
        description: '读取一条世界书条目的正文。给 pattern 则只返回命中的片段，不返回全文。'
            + '整段重写（lore_rewrite）之前必须先读到全文；追加或替换前先确认正文里已有什么。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，与 lore_list 里显示的完全一致。',
                },
                pattern: {
                    type: 'string',
                    description: '正则表达式。给了就只返回命中片段及其位置，不返回全文。',
                },
                flags: {
                    type: 'string',
                    description: 'i 忽略大小写、m 多行、s 让 . 匹配换行，可连写如 im。不支持 g。',
                },
            },
            required: ['title'],
        },
        action: guardAction(TOOL_NAMES.LORE_READ, handleLoreRead),
        formatMessage: params => `读取世界书条目：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_ADD,
        displayName: '新建世界书条目',
        description: '新建一条世界书条目。标题已存在时返回 TITLE_EXISTS，不会覆盖。'
            + '新建前先看目录，避免写出内容重复的条目。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，同书内唯一。用短的专有名词，不要写成句子。',
                },
                content: {
                    type: 'string',
                    description: '条目正文，完整内容。',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '触发关键词，至少 1 个。没有关键词的条目永远不会被触发。',
                },
                logic: {
                    type: 'string',
                    enum: ['any', 'all', 'not_all', 'not_any'],
                    description: '关键词组合方式，省略表示 any（任一命中）。',
                },
            },
            required: ['title', 'content', 'keys'],
        },
        action: guardAction(TOOL_NAMES.LORE_ADD, handleLoreAdd),
        formatMessage: params => `新建世界书条目：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_APPEND,
        displayName: '追加世界书条目',
        description: '在已有条目正文末尾追加内容，或追加触发关键词，原文一个字都不动。'
            + '只给 content 只加正文，只给 keys 只加关键词。'
            + '只要目录里见过这条标题就能调用，不需要先读全文。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，必须已存在。',
                },
                content: {
                    type: 'string',
                    description: '追加到正文末尾的内容，与原文之间自动空一行。',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '追加的触发关键词。已存在的自动跳过，超过上限的截断。',
                },
            },
            required: ['title'],
        },
        action: guardAction(TOOL_NAMES.LORE_APPEND, handleLoreAppend),
        formatMessage: params => `追加世界书条目：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_REPLACE,
        displayName: '正则替换世界书正文',
        description: '用正则替换条目正文里的片段，未被匹配的部分原样保留。'
            + '替换前先用 lore_read 带同一个 pattern 看一眼会命中什么。'
            + '0 处匹配、或多处匹配而 replace_all=false 时直接拒绝并返回命中情况，不会猜。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题。',
                },
                pattern: {
                    type: 'string',
                    description: '要匹配的正则，与预读时用的完全一致。',
                },
                replacement: {
                    type: 'string',
                    description: '替换成的文本，支持 $1 引用捕获组；空串表示删掉这段匹配。',
                },
                replace_all: {
                    type: 'boolean',
                    description: '是否替换所有匹配。默认 false，此时出现多处匹配会拒绝。',
                },
                flags: {
                    type: 'string',
                    description: 'i / m / s / u，可连写。不支持 g（由 replace_all 控制）。',
                },
            },
            required: ['title', 'pattern', 'replacement'],
        },
        action: guardAction(TOOL_NAMES.LORE_REPLACE, handleLoreReplace),
        formatMessage: params => `替换世界书正文：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_REWRITE,
        displayName: '整段重写世界书正文',
        description: '用新正文整段替换条目正文，用于压缩过长条目或重排结构。'
            + '只改正文：标题、关键词、触发方式一律保持原样，要改关键词用 lore_append。'
            + '改写前必须先读到全文。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题。',
                },
                content: {
                    type: 'string',
                    description: '新的正文全文，不是片段。',
                },
            },
            required: ['title', 'content'],
        },
        action: guardAction(TOOL_NAMES.LORE_REWRITE, handleLoreRewrite),
        formatMessage: params => `重写世界书正文：${params?.title ?? ''}`,
    });
}

/* ------------------------------------------------------------ 描述工具 */

function buildDescTools() {
    define({
        name: TOOL_NAMES.DESC_READ,
        displayName: '读取角色描述',
        description: '读取当前角色的描述。省略 pattern 返回全文与字数；给 pattern 只返回命中片段。'
            + '写入前先读：追加和替换至少要知道描述里已有什么，整段重写必须读到全文。',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '正则表达式。给了就只返回命中片段及其位置，不返回全文。',
                },
                flags: {
                    type: 'string',
                    description: 'i 忽略大小写、m 多行、s 让 . 匹配换行，可连写如 im。不支持 g。',
                },
            },
        },
        action: guardAction(TOOL_NAMES.DESC_READ, handleDescRead),
        formatMessage: params => (isBlank(params?.pattern) ? '读取角色描述' : `检索角色描述：${params.pattern}`),
    });

    define({
        name: TOOL_NAMES.DESC_APPEND,
        displayName: '追加角色描述',
        description: '在角色描述末尾追加一段，原文不动。'
            + '只放角色自身的经历、外貌、认知与态度，不放世界设定。',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: '要追加的内容，与原文之间自动空一行。',
                },
            },
            required: ['text'],
        },
        action: guardAction(TOOL_NAMES.DESC_APPEND, handleDescAppend),
        formatMessage: () => '追加角色描述',
    });

    define({
        name: TOOL_NAMES.DESC_REPLACE,
        displayName: '正则替换角色描述',
        description: '用正则替换角色描述里的片段，未被匹配的部分原样保留。'
            + '替换前先用 desc_read 带同一个 pattern 看一眼会命中什么。'
            + '0 处匹配、或多处匹配而 replace_all=false 时直接拒绝。',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '要匹配的正则，与预读时用的完全一致。',
                },
                replacement: {
                    type: 'string',
                    description: '替换成的文本，支持 $1 引用捕获组；空串表示删掉这段匹配。',
                },
                replace_all: {
                    type: 'boolean',
                    description: '是否替换所有匹配。默认 false，此时出现多处匹配会拒绝。',
                },
                flags: {
                    type: 'string',
                    description: 'i / m / s / u，可连写。不支持 g（由 replace_all 控制）。',
                },
            },
            required: ['pattern', 'replacement'],
        },
        action: guardAction(TOOL_NAMES.DESC_REPLACE, handleDescReplace),
        formatMessage: params => `替换角色描述：${params?.pattern ?? ''}`,
    });

    define({
        name: TOOL_NAMES.DESC_REWRITE,
        displayName: '整段重写角色描述',
        description: '用新文本整段重写角色描述，用于压缩或整体重排。'
            + '重写前必须先用 desc_read 读到全文。',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: '新的描述全文，不是片段。',
                },
            },
            required: ['text'],
        },
        action: guardAction(TOOL_NAMES.DESC_REWRITE, handleDescRewrite),
        formatMessage: () => '整段重写角色描述',
    });
}

export { getToolDefs };
