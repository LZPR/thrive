
/** 有没有打开一个对话（没有对话时 chat_metadata 是空对象，写进去会丢） */
function isChatAvailable(ctx) {
    try {
        return Boolean(ctx.getCurrentChatId?.());
    } catch {
        return false;
    }
}


/**
 * 保存对话元数据。
 * ST 里 saveMetadata() 本身就是 saveChatConditional() 的别名，
 * 两者都会把 chat_metadata 写进聊天文件的 header。
 */
function saveChat(ctx) {
    if (!isChatAvailable(ctx)) {
        return false;
    }

    try {
        const save = ctx.saveChat ?? ctx.saveMetadata;
        const result = save?.call(ctx);
        if (result && typeof result.catch === 'function') {
            result.catch(err => console.error('[Thrive] 保存对话元数据失败', err));
        }
        return true;
    } catch (err) {
        console.error('[Thrive] 保存对话元数据失败', err);
        return false;
    }
}

export { isChatAvailable, saveChat };
