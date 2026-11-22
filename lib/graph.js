import { GraphError } from './errors.js';

export const GRAPH_BASE_URL = 'https://graph.facebook.com';

/**
 * Fields requested when listing templates, so normalization always sees the same shape.
 */
export const TEMPLATE_FIELDS = 'id,name,language,category,status,parameter_format,components';

/**
 * Fields for a template overview (no components): enough to pick templates and spot overwrites.
 */
export const SUMMARY_FIELDS = 'id,name,language,category,status';

/**
 * @typedef {object} GraphClient
 * @property {(wabaId: string, fields?: string) => Promise.<object[]>} listTemplates - All templates,
 * all pages.
 * @property {(wabaId: string, body: object) => Promise.<object>} createTemplate
 * @property {(templateId: string, body: object) => Promise.<object>} updateTemplate
 * @property {(wabaId: string, name: string, templateId: string) => Promise.<object>} deleteTemplate
 * @property {(wabaId: string) => Promise.<object>} getWaba
 * @property {(wabaId: string) => Promise.<object[]>} probeTemplates - First page, one template.
 * @property {() => Promise.<object>} debugToken - Meta's description of this token.
 * @property {(wabaId: string) => Promise.<object[]>} listPhoneNumbers - Sender phone numbers.
 * @property {(businessId: string) => Promise.<object[]>} listBusinessWabas - WABAs a business
 * portfolio owns or has access to as a client.
 */

/**
 * Meta access tokens start with "EAA"; Meta sometimes repeats a rejected token in its error text.
 */
const TOKEN_PATTERN = /EAA[\w-]{16,}/g;

/**
 * Removes the access token (and anything that looks like a Meta token) from text that may be shown
 * or logged, e.g. Meta's own error messages.
 *
 * @param {string|undefined} text
 * @param {string} token
 * @returns {string|undefined}
 */
export function redact(text, token) {
    if (typeof text !== 'string') {
        return text;
    }
    let withoutToken = text;
    if (token && new RegExp(`^${TOKEN_PATTERN.source}$`).test(token)) {
        // A real Meta token is removed wherever it appears, also when Meta repeats it back to back.
        withoutToken = text.split(token).join('[token removed]');
    } else if (token) {
        // Anything else (e.g. a short value pasted by mistake) only as a whole word, so it cannot cut
        // letters out of Meta's text.
        const escaped = token.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
        withoutToken = text.replaceAll(
            new RegExp(String.raw`(?<![\w-])${escaped}(?![\w-])`, 'g'),
            '[token removed]',
        );
    }
    return withoutToken.replaceAll(TOKEN_PATTERN, '[token removed]');
}

/**
 * Thin Graph API client for one access token. The token is sent as a bearer header only.
 *
 * @param {object} options
 * @param {string} options.token - Access token.
 * @param {string} options.version - Graph version, e.g. `v23.0`.
 * @param {typeof fetch} [options.fetchImpl] - Injected `fetch` (tests).
 * @param {string} [options.baseUrl]
 * @returns {GraphClient}
 */
export function createGraphClient({ token, version, fetchImpl = fetch, baseUrl = GRAPH_BASE_URL }) {
    const root = `${baseUrl}/${version}/`;

    /**
     * @param {string} method
     * @param {string} urlOrPath - Path below the version root, or an absolute paging URL.
     * @param {object} [options]
     * @param {Object.<string, string>} [options.query]
     * @param {object} [options.body]
     * @returns {Promise.<any>}
     */
    async function request(method, urlOrPath, { query, body } = {}) {
        const url = new URL(urlOrPath, root);
        if (url.origin !== new URL(root).origin) {
            // Never send the token to another host (e.g. an unexpected paging URL).
            throw new GraphError({ httpStatus: 0, message: `Refusing request to ${url.origin}` });
        }
        const parameters = Object.entries(query ?? {});
        for (const [key, value] of parameters) {
            url.searchParams.set(key, value);
        }
        const response = await fetchImpl(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body && { 'Content-Type': 'application/json' }),
            },
            ...(body && { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { raw: text };
            }
        }
        if (!response.ok || data.error) {
            const error = data.error ?? {};
            throw new GraphError({
                httpStatus: response.status,
                message: redact(error.message ?? `HTTP ${response.status}`, token),
                code: error.code,
                subcode: error.error_subcode,
                userTitle: redact(error.error_user_title, token),
                userMessage: redact(error.error_user_msg, token),
                traceId: error.fbtrace_id,
            });
        }
        return data;
    }

    /**
     * Reads every page of a list edge.
     *
     * @param {string} path
     * @param {string} fields
     * @returns {Promise.<object[]>}
     */
    async function listAll(path, fields) {
        const items = [];
        let page = await request('GET', path, { query: { fields, limit: '100' } });
        items.push(...(page.data ?? []));
        while (page.paging?.next) {
            page = await request('GET', page.paging.next);
            items.push(...(page.data ?? []));
        }
        return items;
    }

    return {
        listTemplates(wabaId, fields = TEMPLATE_FIELDS) {
            return listAll(`${encodeURIComponent(wabaId)}/message_templates`, fields);
        },
        async debugToken() {
            const response = await request('GET', 'debug_token', { query: { input_token: token } });
            return response.data ?? {};
        },
        async listBusinessWabas(businessId) {
            const id = encodeURIComponent(businessId);
            const [owned, client] = await Promise.all([
                listAll(`${id}/owned_whatsapp_business_accounts`, 'id,name'),
                listAll(`${id}/client_whatsapp_business_accounts`, 'id,name'),
            ]);
            return [...owned, ...client];
        },
        listPhoneNumbers(wabaId) {
            return listAll(
                `${encodeURIComponent(wabaId)}/phone_numbers`,
                'id,display_phone_number,verified_name',
            );
        },
        createTemplate(wabaId, body) {
            return request('POST', `${encodeURIComponent(wabaId)}/message_templates`, { body });
        },
        updateTemplate(templateId, body) {
            return request('POST', encodeURIComponent(templateId), { body });
        },
        deleteTemplate(wabaId, name, templateId) {
            return request('DELETE', `${encodeURIComponent(wabaId)}/message_templates`, {
                query: { name, hsm_id: templateId },
            });
        },
        getWaba(wabaId) {
            return request('GET', encodeURIComponent(wabaId), { query: { fields: 'id,name' } });
        },
        async probeTemplates(wabaId) {
            const page = await request('GET', `${encodeURIComponent(wabaId)}/message_templates`, {
                query: { fields: 'id,name', limit: '1' },
            });
            return page.data ?? [];
        },
    };
}
