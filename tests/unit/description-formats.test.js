import { describe, expect, it } from 'vitest';
import { parseAliChat, parsePList, serializeAliChat, serializePList } from '../../src/core/description-formats.js';

describe('description text formats', () => {
    it('reads common PLists with nested descriptors and preserves category order', () => {
        const text = "[Eden's persona: kind, hobbies(reading, games); Eden's appearance: hair(red), tall]";
        const parsed = parsePList(text);
        expect(Object.keys(parsed)).toEqual(["Eden's persona", "Eden's appearance"]);
        expect(parsed["Eden's persona"]).toEqual(['kind', 'hobbies(reading, games)']);
        expect(serializePList(parsed)).toBe(text);
    });

    it('round trips delimiter characters, Unicode and special dictionary keys', () => {
        const value = JSON.parse('{"__proto__":["茶; 酒","a, b","[括号]","quote\\"","unclosed("],"character: traits":["多行\\n内容"]}');
        expect(parsePList(serializePList(value))).toEqual(value);
        expect(parsePList('')).toEqual({});
        expect(serializePList({})).toBe('');
        for (const text of ['plain text', '[x: a; x: b]', '[x: a(b]', '[x: "broken]']) {
            expect(() => parsePList(text)).toThrow();
        }
    });

    it('round trips ordered Ali:Chat interviews with multiline answers', () => {
        const value = [
            { question: "What's your name?", answer: '我是小明。\n*微笑*' },
            { question: '喜欢什么？', answer: '茶。' },
        ];
        const text = serializeAliChat(value);
        expect(text).toContain('<START>\n{{user}}: ');
        expect(parseAliChat(text)).toEqual(value);
        expect(parseAliChat('')).toEqual([]);
        expect(() => parseAliChat('unrecognized text')).toThrow();
        expect(() => serializeAliChat([{ question: 'Q', answer: 'A\n<START>\n破坏结构' }])).toThrow();
    });
});
