// Node tests need event dispatch, not a simulated browser. DOM tests opt into jsdom per file.
if (typeof document === 'undefined') {
    const events = new EventTarget();
    events.getElementById = () => null;
    globalThis.document = events;
}
