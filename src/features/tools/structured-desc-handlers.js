import { parseAliChat, parsePList, serializeAliChat, serializePList, validateDialogue } from '../../core/description-formats.js';
import { readLimits } from '../../core/limits.js';
import { getContext } from '../../platform/sillytavern/context.js';
import { fnv1a } from '../../shared/util.js';
import { ensureDescEntry, readDesc, writeDesc } from '../memory/desc.js';
import { ensureSettings, getReadHash, saveChat, setReadHash } from '../settings/index.js';
import { errorResult } from './tool-contracts.js';
import { isToolAvailable } from './tool-availability.js';

const FORMATS = {
    plist: { parse: parsePList, serialize: serializePList },
    alichat: { parse: parseAliChat, serialize: serializeAliChat },
};

function badArgument(hint) {
    return errorResult('INVALID_ARGUMENT', hint);
}

function readKey(format, book, selection = null) {
    return `structured:${JSON.stringify([format, book, selection])}`;
}

function selectionOf(format, params) {
    return format === 'plist' ? params.key : params.index;
}

function payload(format, data) {
    return format === 'plist'
        ? { categories: data }
        : { items: data.map((item, index) => ({ index, ...item })) };
}

/** 所有操作共用格式解析和版本守卫，避免“读的是 A、写的是 B”。 */
export async function handleStructuredDesc(format, operation, params = {}) {
    const ctx = getContext();
    const name = `${format}_${operation}`;
    if (!isToolAvailable(name)) return errorResult('TOOL_UNAVAILABLE');
    const metadata = ctx.chatMetadata;
    const chatId = ctx.getCurrentChatId?.();
    if (operation === 'read') {
        const ensured = await ensureDescEntry(ctx, format);
        if (!ensured.ok) return ensured;
    }
    const read = await readDesc(ctx, format);
    if (!isToolAvailable(name) || ctx.chatMetadata !== metadata || ctx.getCurrentChatId?.() !== chatId) {
        return errorResult('TOOL_UNAVAILABLE');
    }
    if (!read.ok && read.error !== 'NO_DESC_BOOK') return read;
    const text = read.text;
    const book = read.book ?? '';
    let data;
    try {
        data = FORMATS[format].parse(text);
    } catch (err) {
        return errorResult('INVALID_DESCRIPTION_FORMAT', `专属条目无法解析，未修改原文：${err.message}`);
    }

    const selected = selectionOf(format, params);
    if (operation === 'read') {
        if (format === 'plist' && selected !== undefined && (typeof selected !== 'string' || !selected.trim())) {
            return badArgument('key 必须是非空分类名称。');
        }
        if (format === 'alichat' && selected !== undefined && (!Number.isInteger(selected) || selected < 0)) {
            return badArgument('index 必须是从 0 开始的整数。');
        }
        setReadHash(ctx, readKey(format, book, selected), fnv1a(text));
        if (selected === undefined) return { ok: true, ...payload(format, data) };
        if (format === 'plist') {
            const exists = Object.hasOwn(data, selected);
            return { ok: true, key: selected, exists, traits: exists ? data[selected] : [] };
        }
        return { ok: true, index: selected, exists: selected < data.length, item: data[selected] ?? null };
    }

    // 新增问答会改变列表长度，需要先看整个列表；按位置修改/删除允许只读该位置。
    const specific = format === 'alichat' && operation === 'add' ? null : selected;
    const recorded = [
        getReadHash(ctx, readKey(format, book, specific)),
        getReadHash(ctx, readKey(format, book)),
    ].filter(Boolean);
    if (!recorded.length) return errorResult('READ_REQUIRED', `先用 ${format}_read 查看要操作的内容，再进行修改。`);
    if (!recorded.includes(fnv1a(text))) return errorResult('STALE_READ', '条目在读取后发生变化，请重新读取再修改。');

    try {
        const changed = format === 'plist' ? changePList(data, operation, params) : changeAliChat(data, operation, params);
        if (!changed.ok) return changed;
        const next = FORMATS[format].serialize(data);
        if (next.length > readLimits(ensureSettings(ctx)).hardLimitDesc) {
            return errorResult('TOO_LONG', '序列化后的描述超过角色描述硬上限，请精简属性或问答。');
        }
        const written = await writeDesc(ctx, next, format, {
            expectedText: text,
            guard: () => isToolAvailable(name) && ctx.chatMetadata === metadata && ctx.getCurrentChatId?.() === chatId,
        });
        if (!written.ok) return written;
        // 返回完整结构，因此模型可继续操作它刚刚看见的新版本。
        setReadHash(ctx, readKey(format, written.book), fnv1a(next));
        saveChat(ctx);
        return { ok: true, ...payload(format, data), chars: next.length, draft: true };
    } catch (err) {
        return badArgument(err.message);
    }
}

function traitsOf(value, { optional = false } = {}) {
    if (value === undefined && optional) return null;
    if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) {
        throw new Error('traits 必须是至少含一条非空文字的数组。');
    }
    return [...new Set(value.map(item => item.trim()))];
}

function changePList(data, operation, params) {
    const key = params.key;
    if (typeof key !== 'string' || !key.trim()) return badArgument('key 必须是非空分类名称。');
    const exists = Object.hasOwn(data, key);
    if (operation !== 'add' && !exists) return errorResult('NOT_FOUND', '分类不存在，请先读取确认。');
    const traits = traitsOf(params.traits, { optional: operation === 'delete' });
    if (operation === 'add') {
        // defineProperty 同时支持 "__proto__" 这种合法分类名。
        Object.defineProperty(data, key, {
            value: [...new Set([...(exists ? data[key] : []), ...traits])],
            enumerable: true, configurable: true, writable: true,
        });
    } else if (operation === 'update') {
        data[key] = traits;
    } else if (traits) {
        if (traits.some(trait => !data[key].includes(trait))) return errorResult('NOT_FOUND', '要删除的属性不存在。');
        data[key] = data[key].filter(trait => !traits.includes(trait));
    } else {
        delete data[key];
    }
    return { ok: true };
}

function changeAliChat(data, operation, params) {
    const index = params.index ?? (operation === 'add' ? data.length : undefined);
    if (!Number.isInteger(index) || index < 0) return badArgument('index 必须是从 0 开始的整数。');
    if (index > data.length || (operation !== 'add' && index === data.length)) {
        return errorResult('NOT_FOUND', '问答位置不存在，请重新读取列表。');
    }
    if (operation === 'delete') data.splice(index, 1);
    else {
        const item = { question: validateDialogue(params.question), answer: validateDialogue(params.answer) };
        data.splice(index, operation === 'add' ? 0 : 1, item);
    }
    return { ok: true };
}
