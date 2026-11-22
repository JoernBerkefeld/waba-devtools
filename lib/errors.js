/**
 * Error for wrong command-line usage or an invalid project setup (exit code 2).
 */
export class UsageError extends Error {
    /**
     * @param {string} message - What is wrong and how to fix it.
     * @param {string} [code] - Stable machine-readable reason (e.g. `BUSINESS_ID_REQUIRED`), so callers
     * such as the desktop app can show their own wording.
     */
    constructor(message, code) {
        super(message);
        this.name = 'UsageError';
        if (code) {
            this.code = code;
        }
    }
}

/**
 * Error returned by Meta's Graph API. Carries Meta's own codes and messages, never the token.
 */
export class GraphError extends Error {
    /**
     * @param {object} details
     * @param {number} details.httpStatus - HTTP status of the response.
     * @param {string} details.message - Meta's error message.
     * @param {number} [details.code] - Meta's error code.
     * @param {number} [details.subcode] - Meta's error subcode.
     * @param {string} [details.userTitle] - Meta's `error_user_title`.
     * @param {string} [details.userMessage] - Meta's `error_user_msg`.
     * @param {string} [details.traceId] - Meta's `fbtrace_id`.
     */
    constructor({ httpStatus, message, code, subcode, userTitle, userMessage, traceId }) {
        super(message);
        this.name = 'GraphError';
        this.httpStatus = httpStatus;
        this.code = code;
        this.subcode = subcode;
        this.userTitle = userTitle;
        this.userMessage = userMessage;
        this.traceId = traceId;
    }

    /**
     * One-line description with Meta's codes, for reports.
     *
     * @returns {string}
     */
    describe() {
        const codes = [this.code, this.subcode].filter((value) => value !== undefined).join('/');
        const detail = this.userMessage ? ` — ${this.userMessage}` : '';
        return `${codes ? `(#${codes}) ` : ''}${this.message}${detail}`;
    }
}
