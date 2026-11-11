// Optional host command support remains lazy; import failure is handled by the caller.
export function loadSlashCommands() {
    return Promise.all([
        import('../../../../../../slash-commands/SlashCommandParser.js'),
        import('../../../../../../slash-commands/SlashCommand.js'),
        import('../../../../../../slash-commands/SlashCommandArgument.js'),
    ]);
}
