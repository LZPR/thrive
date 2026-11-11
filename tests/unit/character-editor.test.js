// @vitest-environment jsdom
import { beforeEach, it, expect } from 'vitest';
import { applyDescriptionLocally, refreshDescriptionEditor } from '../../src/features/memory/index.js';

beforeEach(() => {
    document.body.innerHTML = '<input id="character_name_pole" value="角色"><textarea id="description_textarea">旧描述</textarea>';
});

it('updates the memory and hidden editor while normalizing CRLF', () => {
    const character = { name: '角色', description: '旧描述' };
    expect(applyDescriptionLocally(character, '新\r\n描述', '旧描述')).toMatchObject({ synced: true });
    expect(document.querySelector('textarea').value).toBe('新\n描述');
    expect(character.description).toBe('新\n描述');
});

it('preserves a focused edit and allows the explicit fill-editor action', () => {
    const character = { name: '角色', description: '旧描述' };
    const editor = document.querySelector('textarea');
    editor.value = '正在编辑';
    editor.focus();
    expect(applyDescriptionLocally(character, '新描述', '旧描述')).toEqual({ synced: false, reason: 'edited' });
    expect(editor.value).toBe('正在编辑');
    expect(refreshDescriptionEditor(character, '新描述')).toEqual({ synced: true, reason: 'forced' });
    expect(editor.value).toBe('新描述');
});
