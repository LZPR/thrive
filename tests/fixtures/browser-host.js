// Browser-only host double. No credentials, model requests or real SillyTavern data.
const handlers = new Map();
const prefix = '/scripts/extensions/third-party/thrive';
export const state = {
    chatId: 'chat-1',
    extensionSettings: {
        thrive: { connectionProfile: 'offline' },
        connectionManager: { profiles: [{ id: 'offline', name: 'Offline fixture', mode: 'cc' }] },
    },
    chatMetadata: {},
    chat: [{ is_user: true, mes: '北境在南边。' }, { is_user: false, mes: '记住了。' }],
    characters: [{ name: '测试角色', avatar: 'test.png', description: '原始描述' }],
    books: { '测试书': { entries: {} } },
    requests: [],
    writes: 0,
    settingsSaves: 0,
    chatSaves: 0,
    holdRequests: false,
    commands: new Map(),
};

export const eventTypes = {
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
    CHARACTER_EDITED: 'character_edited',
};

export const eventSource = {
    on(name, listener) {
        const list = handlers.get(name) ?? [];
        list.push(listener);
        handlers.set(name, list);
    },
    async emit(name, ...args) {
        await Promise.all((handlers.get(name) ?? []).map(listener => listener(...args)));
    },
};

const connections = {
    getProfile: id => ({ id, mode: 'cc' }),
    isProfileSupported: () => true,
    async sendRequest(profileId, messages, maxTokens, options, payload) {
        state.requests.push(structuredClone({ profileId, messages, payload, includePreset: options.includePreset }));
        if (state.holdRequests) {
            await new Promise((done, reject) => {
                const abort = () => reject(new DOMException('Stopped', 'AbortError'));
                if (options.signal.aborted) {
                    abort();
                } else {
                    options.signal.addEventListener('abort', abort, { once: true });
                }
            });
        }
        return { choices: [{ message: { content: '离线会话完成' } }] };
    },
};

export function getContext() {
    return {
        ...state,
        characterId: 0,
        eventTypes,
        eventSource,
        chatCompletionSettings: { openai_max_context: 8192, openai_max_tokens: 1024 },
        ConnectionManagerRequestService: connections,
        getCurrentChatId: () => state.chatId,
        saveSettingsDebounced: () => { state.settingsSaves += 1; },
        saveChat: () => { state.chatSaves += 1; },
        getWorldInfoNames: () => Object.keys(state.books),
        loadWorldInfo: async name => structuredClone(state.books[name] ?? { entries: {} }),
        saveWorldInfo: async (name, data) => { state.books[name] = structuredClone(data); state.writes += 1; },
        updateWorldInfoList: async () => {},
        renderExtensionTemplateAsync: async () => (await fetch(`${prefix}/settings.html`)).text(),
        substituteParams: text => text.replaceAll('{{char}}', '测试角色'),
    };
}

export async function changeChat(id) {
    state.chatId = id;
    state.chatMetadata = {};
    await eventSource.emit(eventTypes.CHAT_CHANGED);
}

export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0 };
export const POPUP_TYPE = { CONFIRM: 1, TEXT: 2 };
export async function callGenericPopup() {
    return POPUP_RESULT.AFFIRMATIVE;
}
export function getPresetManager() {
    return { getPresetList: () => ({ presets: [], preset_names: {} }) };
}
export class SlashCommandParser {
    static addCommandObject(command) {
        state.commands.set(command.name, command.callback);
    }
}
export class SlashCommand {
    static fromProps(properties) {
        return properties;
    }
}
export const ARGUMENT_TYPE = { STRING: 'string' };
export class SlashCommandArgument {
    static fromProps(properties) {
        return properties;
    }
}

export const selected_world_info = [];
export const world_info = {};
