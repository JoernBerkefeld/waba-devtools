import { GraphError } from './errors.js';

export const GRAPH_BASE_URL = 'https://graph.facebook.com';

/**
 * Fields requested when listing templates, so normalization always sees the same shape.
 */
export const TEMPLATE_FIELDS = 'id,name,language,category,status,parameter_format,components';

/**
 * @typedef {object} GraphClient
 * @property {(wabaId: string) => Promise.<object[]>} listTemplates - All templates, all pages.
 * @property {(wabaId: string, body: object) => Promise.<object>} createTemplate
 * @property {(templateId: string, body: object) => Promise.<object>} updateTemplate
 * @property {(wabaId: string, name: string, templateId: string) => Promise.<object>} deleteTemplate
 * @property {(wabaId: string) => Promise.<object>} getWaba
 * @property {(wabaId: string) => Promise.<object[]>} probeTemplates - First page, one template.
 */

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
                message: error.message ?? `HTTP ${response.status}`,
                code: error.code,
                subcode: error.error_subcode,
                userTitle: error.error_user_title,
                userMessage: error.error_user_msg,
                traceId: error.fbtrace_id,
            });
        }
        return data;
    }

    return {
        async listTemplates(wabaId) {
            const templates = [];
            let page = await request('GET', `${encodeURIComponent(wabaId)}/message_templates`, {
                query: { fields: TEMPLATE_FIELDS, limit: '100' },
            });
            templates.push(...(page.data ?? []));
            while (page.paging?.next) {
                page = await request('GET', page.paging.next);
                templates.push(...(page.data ?? []));
            }
            return templates;
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
