import { vi } from 'vitest';

export function createContext({ settings = {}, metadata = {}, chat = [] } = {}) {
    return {
        extensionSettings: { thrive: structuredClone(settings) },
        chatMetadata: structuredClone(metadata),
        chat,
        characterId: 0,
        characters: [{ name: '测试角色', avatar: 'test.png', description: '原始描述' }],
        getCurrentChatId: () => 'test-chat',
        saveSettingsDebounced: vi.fn(),
        saveChat: vi.fn(),
    };
}
