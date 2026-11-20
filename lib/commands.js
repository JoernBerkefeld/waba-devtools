import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    DEFAULT_GRAPH_VERSION,
    getStage,
    pickSourceWaba,
    pickTargetWabas,
    resolveToken,
} from './config.js';
import { readCsvTemplates } from './csv.js';
import { GraphError, UsageError } from './errors.js';
import {
    readTemplateDirectory,
    readTemplateFile,
    templatePath,
    writeTemplateFile,
} from './files.js';
import { createGraphClient, SUMMARY_FIELDS } from './graph.js';
import { mergeBody, normalizeTemplate } from './normalize.js';
import { planDeploy } from './plan.js';

/**
 * @typedef {object} CommonOptions
 * @property {string} cwd - Project root.
 * @property {import('./config.js').Config} config
 * @property {NodeJS.ProcessEnv} [environment] - Environment with the tokens (default `process.env`).
 * @property {typeof fetch} [fetchImpl] - Injected `fetch` (tests).
 */

/**
 * @param {import('./config.js').WabaEntry} entry
 * @param {CommonOptions} options
 * @returns {import('./graph.js').GraphClient}
 */
function clientFor(entry, { config, environment = process.env, fetchImpl }) {
    return createGraphClient({
        token: resolveToken(entry, environment),
        version: config.graphVersion,
        fetchImpl,
    });
}

/**
 * @param {unknown} ex
 * @returns {string}
 */
function describeError(ex) {
    return ex instanceof GraphError ? ex.describe() : ex.message;
}

/**
 * Keeps only the named templates; fails when a name is not in the list.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} nameOf
 * @param {string[]} names
 * @param {string} where - Used in the error message.
 * @returns {T[]}
 */
function selectByName(items, nameOf, names, where) {
    if (names.length === 0) {
        return items;
    }
    const available = new Set(items.map(nameOf));
    const missing = names.filter((name) => !available.has(name));
    if (missing.length > 0) {
        throw new UsageError(`Not found in ${where}: ${missing.join(', ')}.`);
    }
    const wanted = new Set(names);
    return items.filter((item) => wanted.has(nameOf(item)));
}

/**
 * Writes the templates of one WABA into the templates folder.
 *
 * @param {CommonOptions & {from?: string, fromWaba?: string, names?: string[]}} options
 * @returns {Promise.<object>} Report.
 */
export async function retrieve(options) {
    const { config, cwd, from, fromWaba, names = [] } = options;
    const { stage, stages, entry } = pickSourceWaba(config, from, fromWaba);
    const live = await clientFor(entry, options).listTemplates(entry.wabaId);
    const templates = selectByName(
        live.map(normalizeTemplate),
        (template) => template.name,
        names,
        `WABA ${entry.wabaId}`,
    );
    const files = [];
    for (const template of templates) {
        const result = await writeTemplateFile(config.templatesDir, template);
        files.push({
            name: template.name,
            language: template.language,
            result,
            path: path.relative(cwd, templatePath(config.templatesDir, template)),
        });
    }
    return { command: 'retrieve', stage, stages, wabaId: entry.wabaId, files, ok: true };
}

/**
 * Writes CSV rows into template files. Only the body (and, for new files, the category) comes
 * from the CSV; header, footer and buttons of existing files are kept.
 *
 * @param {CommonOptions & {csv: string}} options
 * @returns {Promise.<object>} Report.
 */
export async function importCsv({ config, cwd, csv }) {
    const { templates, errors, cleanup } = await readCsvTemplates(path.resolve(cwd, csv));
    const files = [];
    for (const template of templates) {
        const existing = await readTemplateFile(config.templatesDir, template);
        const merged = existing ? mergeBody(existing, template) : template;
        const result = await writeTemplateFile(config.templatesDir, merged);
        files.push({
            name: template.name,
            language: template.language,
            result,
            path: path.relative(cwd, templatePath(config.templatesDir, template)),
        });
    }
    return {
        command: 'import',
        csv,
        csvCleanup: cleanup,
        files,
        rowErrors: errors,
        ok: errors.length === 0,
    };
}

/**
 * Loads what should be deployed: CSV rows, a live source WABA, or the templates folder.
 *
 * @param {CommonOptions & {from?: string, fromWaba?: string, csv?: string, sourceDir?: string}} options
 * @returns {Promise.<{source: import('./plan.js').SourceTemplate[], description: object, rowErrors: object[]}>}
 */
async function loadSource(options) {
    const { config, cwd, from, fromWaba, csv } = options;
    if (csv) {
        const { templates, errors, cleanup } = await readCsvTemplates(path.resolve(cwd, csv));
        return {
            source: templates.map((template) => ({ template, bodyOnly: true })),
            description: { type: 'csv', csv, cleanup },
            rowErrors: errors,
        };
    }
    if (from || fromWaba) {
        const { stage, stages, entry } = pickSourceWaba(config, from, fromWaba);
        const live = await clientFor(entry, options).listTemplates(entry.wabaId);
        return {
            source: live.map((template) => ({ template: normalizeTemplate(template) })),
            description: { type: 'waba', stage, stages, wabaId: entry.wabaId },
            rowErrors: [],
        };
    }
    const directory = options.sourceDir ?? config.templatesDir;
    const templates = await readTemplateDirectory(directory);
    return {
        source: templates.map((template) => ({ template })),
        description: { type: 'files', dir: path.relative(cwd, directory) || '.' },
        rowErrors: [],
    };
}

/**
 * Creates missing and updates changed templates in every WABA of the target stage.
 *
 * @param {CommonOptions & {
 *   to?: string, toWabas?: string[], from?: string, fromWaba?: string, csv?: string,
 *   names?: string[],
 *   dryRun?: boolean, prune?: boolean, yes?: boolean,
 *   onProgress?: (event: object) => void,
 *   expectedActions?: {wabaId: string, actions: {name: string, language: string, action: string}[]}[],
 *   backupDir?: string, sourceDir?: string
 * }} options
 * @returns {Promise.<object>} Report.
 */
export async function deploy(options) {
    const {
        config,
        to,
        toWabas = [],
        from,
        fromWaba,
        csv,
        names = [],
        dryRun = false,
        prune = false,
        yes = false,
        onProgress,
        expectedActions,
        backupDir,
    } = options;
    const sources = [csv, from || fromWaba, options.sourceDir].filter(Boolean);
    if (sources.length > 1) {
        throw new UsageError('Use only one source: --csv, --from/--from-waba or --from-dir.');
    }
    if (prune && (csv || names.length > 0)) {
        throw new UsageError(
            '--prune only works when deploying the full set (not with -m or --csv).',
        );
    }
    const targets = pickTargetWabas(config, to, toWabas);
    const loaded = await loadSource(options);
    const source = selectByName(loaded.source, (item) => item.template.name, names, 'the source');
    if (prune && source.length === 0) {
        throw new UsageError(
            'The source has no templates; refusing --prune (it would delete all).',
        );
    }
    const isFullSet = names.length === 0 && !csv;
    const results = [];
    if (backupDir && !dryRun) {
        await assertEmptyFolder(backupDir);
    }
    const backup = backupDir
        ? {
              dir: backupDir,
              createdAt: new Date().toISOString(),
              source: loaded.description,
              targets: [],
          }
        : undefined;
    for (const [targetIndex, { stage, stages, entry }] of targets.entries()) {
        const target = { stage, stages, wabaId: entry.wabaId, actions: [] };
        results.push(target);
        let client;
        let live;
        try {
            client = clientFor(entry, options);
            live = await client.listTemplates(entry.wabaId);
        } catch (ex) {
            target.error = describeError(ex);
            continue;
        }
        const planned = planDeploy({ source, target: live, fullSet: isFullSet, prune });
        const hasChanged =
            expectedActions !== undefined &&
            !isSameSendSet(planned, expectedFor(expectedActions, entry.wabaId));
        if (hasChanged) {
            target.error = 'changed since preview — run the preview again';
        }
        const total = planned.filter((action) => SENDING.has(action.action)).length;
        let isBlocked = hasChanged;
        if (backup && !dryRun && !hasChanged && total > 0) {
            try {
                target.backup = await backupTarget(backup, { stage, wabaId: entry.wabaId, live });
            } catch (ex) {
                target.error = `backup failed, nothing sent: ${ex.message}`;
                isBlocked = true;
            }
        }
        let done = 0;
        for (const plannedAction of planned) {
            const { body, ...action } = plannedAction;
            target.actions.push(action);
            if (dryRun || isBlocked || !SENDING.has(action.action)) {
                continue;
            }
            if (!yes && action.action === 'delete') {
                action.result = 'not run (add --yes)';
            } else {
                await sendAction(client, entry.wabaId, action, body);
            }
            done++;
            onProgress?.({
                wabaId: entry.wabaId,
                targetIndex,
                targetCount: targets.length,
                name: action.name,
                language: action.language,
                action: action.action,
                result: action.result,
                done,
                total,
            });
        }
    }
    const isOk =
        loaded.rowErrors.length === 0 &&
        results.every(
            (target) =>
                !target.error &&
                target.actions.every(
                    (action) => action.result !== 'failed' && action.action !== 'blocked',
                ),
        );
    return {
        command: 'deploy',
        dryRun,
        source: loaded.description,
        rowErrors: loaded.rowErrors,
        targets: results,
        ok: isOk,
    };
}

/**
 * A backup folder must be new or empty: reusing one would overwrite the earlier snapshot (the only
 * way back) and mix two runs.
 *
 * @param {string} directory
 * @returns {Promise.<void>}
 */
async function assertEmptyFolder(directory) {
    let entries;
    try {
        entries = await readdir(directory);
    } catch (ex) {
        if (ex.code === 'ENOENT') {
            return;
        }
        throw new UsageError(`Cannot use backup folder ${directory}: ${ex.message}`);
    }
    if (entries.length > 0) {
        throw new UsageError(
            `Backup folder ${directory} is not empty. Use a new folder for every backup.`,
        );
    }
}

/**
 * Writes the full template set of one target into the backup folder and refreshes the manifest.
 *
 * @param {{dir: string, createdAt: string, source: object, targets: object[]}} backup - Run state.
 * @param {{stage: string, wabaId: string, live: object[]}} target
 * @returns {Promise.<string>} Folder of this target's backup.
 */
async function backupTarget(backup, { stage, wabaId, live }) {
    const directory = path.join(backup.dir, wabaId);
    for (const template of live) {
        await writeTemplateFile(directory, normalizeTemplate(template));
    }
    backup.targets.push({ stage, wabaId, templateCount: live.length });
    const { version } = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const manifest = {
        tool: 'waba-devtools',
        version,
        createdAt: backup.createdAt,
        source: backup.source,
        targets: backup.targets,
    };
    await mkdir(backup.dir, { recursive: true });
    await writeFile(
        path.join(backup.dir, 'manifest.json'),
        `${JSON.stringify(manifest, undefined, 4)}\n`,
    );
    return directory;
}

/**
 * Actions that send something to Meta.
 */
const SENDING = new Set(['create', 'update', 'delete']);

/**
 * The confirmed preview actions of one target WABA.
 *
 * @param {{wabaId: string, actions?: {name: string, language: string, action: string}[]}[]} expected
 * @param {string} wabaId
 * @returns {{name: string, language: string, action: string}[]}
 */
function expectedFor(expected, wabaId) {
    return expected.find((target) => target.wabaId === wabaId)?.actions ?? [];
}

/**
 * True when both lists would send the same create/update/delete for the same templates.
 *
 * @param {{name: string, language: string, action: string}[]} planned
 * @param {{name: string, language: string, action: string}[]} expected
 * @returns {boolean}
 */
function isSameSendSet(planned, expected) {
    return sendKey(planned) === sendKey(expected);
}

/**
 * @param {{name: string, language: string, action: string}[]} actions
 * @returns {string} Sorted create/update/delete keys.
 */
function sendKey(actions) {
    return actions
        .filter((action) => SENDING.has(action.action))
        .map((action) => `${action.action}:${action.name}:${action.language}`)
        .toSorted((a, b) => a.localeCompare(b))
        .join('\n');
}

/**
 * Sends one planned action and records the result on it.
 *
 * @param {import('./graph.js').GraphClient} client
 * @param {string} wabaId
 * @param {object} action - Report entry, updated in place.
 * @param {object} [body] - Request body from the plan.
 * @returns {Promise.<void>}
 */
async function sendAction(client, wabaId, action, body) {
    try {
        if (action.action === 'create') {
            const response = await client.createTemplate(wabaId, body);
            action.templateId = response.id;
            action.statusAfter = response.status;
        } else if (action.action === 'update') {
            await client.updateTemplate(action.templateId, body);
        } else {
            await client.deleteTemplate(wabaId, action.name, action.templateId);
        }
        action.result = 'done';
    } catch (ex) {
        action.result = 'failed';
        action.error = describeError(ex);
    }
}

/**
 * Template overview per WABA (name, language, category, status) without components or files.
 * Takes either a source (`from`/`fromWaba`) or targets (`to`/`toWabas`).
 *
 * @param {CommonOptions & {
 *   from?: string, fromWaba?: string, to?: string, toWabas?: string[]
 * }} options
 * @returns {Promise.<object>} Report.
 */
export async function listTemplates(options) {
    const { config, from, fromWaba, to, toWabas = [] } = options;
    const isSource = Boolean(from || fromWaba);
    if (isSource && (to || toWabas.length > 0)) {
        throw new UsageError(
            'List either a source (--from/--from-waba) or targets (--to/--to-waba).',
        );
    }
    const entries = isSource
        ? [pickSourceWaba(config, from, fromWaba)]
        : pickTargetWabas(config, to, toWabas);
    const wabas = [];
    for (const { stage, stages, entry } of entries) {
        const result = { stage, stages, wabaId: entry.wabaId };
        wabas.push(result);
        try {
            const live = await clientFor(entry, options).listTemplates(
                entry.wabaId,
                SUMMARY_FIELDS,
            );
            result.templates = live
                .map(({ name, language, category, status }) => ({
                    name,
                    language,
                    category,
                    status,
                }))
                .toSorted(
                    (a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language),
                );
        } catch (ex) {
            result.error = describeError(ex);
        }
    }
    return { command: 'list', wabas, ok: wabas.every((waba) => !waba.error) };
}

/**
 * The WABAs an access token can manage, with their names and phone numbers. Read-only; needs no
 * config, so it helps to write one.
 *
 * @param {object} options
 * @param {string} options.token - Access token (never logged or returned).
 * @param {string} [options.graphVersion]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise.<object>} Report.
 */
export async function discoverWabas({ token, graphVersion = DEFAULT_GRAPH_VERSION, fetchImpl }) {
    const client = createGraphClient({ token, version: graphVersion, fetchImpl });
    const info = await client.debugToken();
    if (info.is_valid === false) {
        throw new UsageError('Meta says this access token is not valid (expired or revoked).');
    }
    const scope = (info.granular_scopes ?? []).find(
        (candidate) => candidate.scope === 'whatsapp_business_management',
    );
    if (!scope) {
        throw new UsageError(
            'This access token has no whatsapp_business_management permission. Generate it again with that permission.',
        );
    }
    const ids = scope.target_ids ?? [];
    if (ids.length === 0) {
        throw new UsageError(
            'Meta did not list which WABAs this token can reach. Add the WABA IDs by hand.',
        );
    }
    const wabas = [];
    for (const wabaId of ids) {
        const result = { wabaId };
        wabas.push(result);
        try {
            result.name = (await client.getWaba(wabaId)).name;
            result.phoneNumbers = (await client.listPhoneNumbers(wabaId)).map((phone) => ({
                id: phone.id,
                displayPhoneNumber: phone.display_phone_number,
                verifiedName: phone.verified_name,
            }));
        } catch (ex) {
            result.error = describeError(ex);
        }
    }
    return { command: 'discover', wabas, ok: wabas.every((waba) => !waba.error) };
}

/**
 * Read-only access check: token present, WABA reachable, templates listable.
 *
 * @param {CommonOptions & {stage?: string}} options
 * @returns {Promise.<object>} Report.
 */
export async function check(options) {
    const { config, stage } = options;
    const stages = stage ? [stage] : Object.keys(config.stages);
    const entries = [];
    for (const name of stages) {
        for (const entry of getStage(config, name)) {
            const result = { stage: name, wabaId: entry.wabaId, tokenEnv: entry.tokenEnv };
            entries.push(result);
            try {
                const client = clientFor(entry, options);
                const waba = await client.getWaba(entry.wabaId);
                result.wabaName = waba.name;
                await client.probeTemplates(entry.wabaId);
                result.ok = true;
            } catch (ex) {
                result.ok = false;
                result.error = describeError(ex);
            }
        }
    }
    return { command: 'check', entries, ok: entries.every((entry) => entry.ok) };
}
