import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.wabadev-test-run';

/**
 * Creates a per-run scratch root below the OS temp folder. `cleanup()` removes only entries
 * registered via `add()` (strict descendants, no links), then the marker and the empty root.
 *
 * @returns {{root: string, add: (name: string) => string, cleanup: () => void}}
 */
export function createRunRoot() {
    const prefix = path.join(os.tmpdir(), 'wabadev-test-');
    const root = realpathSync(mkdtempSync(prefix));
    const marker = randomBytes(16).toString('hex');
    writeFileSync(path.join(root, MARKER), marker);
    const registered = new Set();
    return {
        root,
        add(name) {
            const target = path.resolve(root, name);
            if (path.dirname(target) !== root || name.includes('..')) {
                throw new Error(`Refusing to register ${name}: not a direct child of the run root`);
            }
            registered.add(target);
            return target;
        },
        cleanup() {
            for (const target of registered) {
                if (path.dirname(target) !== root) {
                    throw new Error(`Refusing to delete ${target}`);
                }
                let stat;
                try {
                    stat = lstatSync(target);
                } catch {
                    continue;
                }
                if (stat.isSymbolicLink()) {
                    throw new Error(`Refusing to delete link ${target}`);
                }
                rmSync(target, { recursive: true, force: true });
            }
            rmSync(path.join(root, MARKER), { force: true });
            rmdirSync(root);
        },
    };
}

/**
 * @param {number} status
 * @param {object} body
 * @returns {Response}
 */
function json(status, body) {
    return Response.json(body, { status });
}

/**
 * @param {number} status
 * @param {string} message
 * @param {number} code
 * @returns {Response}
 */
function fail(status, message, code) {
    return json(status, { error: { message, code } });
}

/**
 * In-memory stand-in for the Graph API's template endpoints.
 *
 * @param {object} setup
 * @param {Object.<string, {token: string, name?: string, templates?: object[], pageSize?: number,
 *   failCreate?: object}>} setup.wabas
 * @param {string} [setup.version]
 * @returns {{fetchImpl: typeof fetch, calls: object[], wabas: object}}
 */
export function createFakeGraph({ wabas, version = 'v23.0' }) {
    const byId = new Map(Object.entries(wabas));
    const calls = [];
    let nextId = 9000;
    for (const waba of Object.values(wabas)) {
        waba.templates = (waba.templates ?? []).map((template) => ({
            id: String(nextId++),
            status: 'APPROVED',
            ...structuredClone(template),
        }));
    }
    const findTemplate = (id) => {
        for (const [wabaId, waba] of Object.entries(wabas)) {
            const template = waba.templates.find((candidate) => candidate.id === id);
            if (template) {
                return { wabaId, waba, template };
            }
        }
        return;
    };

    /**
     * @type {typeof fetch}
     */
    async function fetchImpl(input, init = {}) {
        const url = new URL(input);
        const method = init.method ?? 'GET';
        const auth = init.headers?.Authorization ?? '';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({
            method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            body,
        });
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] !== version) {
            return fail(400, 'Unknown version', 2635);
        }
        const [, id, edge] = parts;
        const waba = byId.get(id);
        const owner = waba ?? findTemplate(id)?.waba;
        if (!owner) {
            return fail(400, `Unsupported request: object ${id} does not exist`, 100);
        }
        if (auth !== `Bearer ${owner.token}`) {
            return fail(401, 'Invalid OAuth access token', 190);
        }
        if (edge === 'message_templates' && waba) {
            if (method === 'GET') {
                const limit = Number(url.searchParams.get('limit') ?? 25);
                const size = Math.min(limit, waba.pageSize ?? limit);
                const after = Number(url.searchParams.get('after') ?? 0);
                const data = waba.templates.slice(after, after + size);
                const page = { data };
                if (after + size < waba.templates.length) {
                    const next = new URL(url);
                    next.searchParams.set('after', String(after + size));
                    page.paging = { next: next.href };
                }
                return json(200, page);
            }
            if (method === 'POST') {
                const failure = new Map(Object.entries(waba.failCreate ?? {})).get(body.name);
                if (failure) {
                    return json(400, { error: failure });
                }
                const exists = waba.templates.some(
                    (template) =>
                        template.name === body.name && template.language === body.language,
                );
                if (exists) {
                    return fail(400, 'Template name already exists for this language', 100);
                }
                const created = { id: String(nextId++), status: 'PENDING', ...body };
                waba.templates.push(created);
                return json(200, { id: created.id, status: 'PENDING', category: body.category });
            }
            if (method === 'DELETE') {
                const before = waba.templates.length;
                waba.templates = waba.templates.filter(
                    (template) =>
                        !(
                            template.name === url.searchParams.get('name') &&
                            template.id === url.searchParams.get('hsm_id')
                        ),
                );
                return json(200, { success: waba.templates.length < before });
            }
        }
        if (!edge && method === 'GET' && waba) {
            return json(200, { id, name: waba.name ?? `WABA ${id}` });
        }
        const found = findTemplate(id);
        if (found && !edge && method === 'POST') {
            if (!['APPROVED', 'REJECTED', 'PAUSED'].includes(found.template.status)) {
                return fail(400, 'Template cannot be edited in its current status', 100);
            }
            Object.assign(found.template, body, { status: 'PENDING' });
            return json(200, { success: true });
        }
        return fail(400, 'Unsupported request', 100);
    }

    return { fetchImpl, calls, wabas };
}

/**
 * A body-only utility template as Meta returns it.
 *
 * @param {string} name
 * @param {string} language
 * @param {string} text
 * @param {object} [extra]
 * @returns {object}
 */
export function bodyTemplate(name, language, text, extra = {}) {
    return {
        name,
        language,
        category: 'UTILITY',
        parameter_format: 'POSITIONAL',
        components: [{ type: 'BODY', text }],
        ...extra,
    };
}
