// Used only by the test resolver. Production imports the real host through platform/sillytavern.
let current = null;

export function setContext(ctx) {
    current = ctx;
}

export function getContext() {
    if (!current) {
        throw new Error('Set a test context before calling host-dependent behavior');
    }
    return current;
}

export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0 };
export const POPUP_TYPE = { CONFIRM: 1 };
export async function callGenericPopup() {
    return POPUP_RESULT.NEGATIVE;
}
