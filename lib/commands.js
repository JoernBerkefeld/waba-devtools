import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { mergeParts, normalizeTemplate, templateKey } from './normalize.js';
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
    const { templates, errors, cleanup, parts } = await readCsvTemplates(path.resolve(cwd, csv));
    const files = [];
    for (const template of templates) {
        const existing = await readTemplateFile(config.templatesDir, template);
        const merged = existing ? mergeParts(existing, template, parts) : template;
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
        const { templates, errors, cleanup, parts } = await readCsvTemplates(
            path.resolve(cwd, csv),
        );
        return {
            source: templates.map((template) => ({ template, parts })),
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
 *   backupDir?: string, backupAfter?: boolean, sourceDir?: string,
 *   templateKeys?: string[] - only these templates, as `name::language` (e.g. a selection from a backup)
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
        backupAfter = false,
        templateKeys,
    } = options;
    if (backupAfter && !backupDir) {
        throw new UsageError('--backup-after needs --backup <folder>.');
    }
    const sources = [csv, from || fromWaba, options.sourceDir].filter(Boolean);
    if (sources.length > 1) {
        throw new UsageError('Use only one source: --csv, --from/--from-waba or --from-dir.');
    }
    if (prune && (csv || templateKeys || names.length > 0)) {
        throw new UsageError(
            '--prune only works when deploying the full set (not with -m or --csv).',
        );
    }
    const targets = pickTargetWabas(config, to, toWabas);
    const loaded = await loadSource(options);
    if (templateKeys?.length === 0) {
        throw new UsageError('No templates selected — select at least one template.');
    }
    const byName = selectByName(loaded.source, (item) => item.template.name, names, 'the source');
    const source = templateKeys
        ? selectByName(byName, (item) => templateKey(item.template), templateKeys, 'the source')
        : byName;
    if (prune && source.length === 0) {
        throw new UsageError(
            'The source has no templates; refusing --prune (it would delete all).',
        );
    }
    const isFullSet = names.length === 0 && !templateKeys && !csv;
    const results = [];
    const createdAt = new Date().toISOString();
    const backup = backupDir
        ? { root: backupDir, runAt: createdAt, source: loaded.description }
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
                target.backup = await backupTarget(backup, {
                    stage,
                    wabaId: entry.wabaId,
                    live,
                    phase: 'before',
                });
            } catch (ex) {
                target.error = `backup failed, nothing sent: ${ex.message}`;
                isBlocked = true;
            }
        }
        let done = 0;
        let sent = 0;
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
                if (action.result === 'done') {
                    sent++;
                }
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
        if (backup && backupAfter && sent > 0) {
            try {
                target.backupAfter = await backupTarget(backup, {
                    stage,
                    wabaId: entry.wabaId,
                    live: await client.listTemplates(entry.wabaId),
                    phase: 'after',
                });
            } catch (ex) {
                target.backupAfterError = `after-backup failed (changes were sent): ${describeError(ex)}`;
            }
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
 * Folder name of one backup set: the WABA ID, the UTC time of the deploy run (file-name safe) and
 * whether it was taken before or after the changes,
 * e.g. `444444444444444_2026-11-20T18-26-04-123Z_before`.
 *
 * @param {string} wabaId
 * @param {string} runAt - ISO timestamp of the deploy run (same for the before and after set).
 * @param {'before'|'after'|'manual'} phase
 * @returns {string}
 */
export function backupSetName(wabaId, runAt, phase) {
    return `${wabaId}_${runAt.replaceAll(/[:.]/g, '-')}_${phase}`;
}

/**
 * Writes one backup set: the full template set of one target WABA plus a manifest that lists the
 * templates, so a backup can be browsed without reading every file. An existing set folder is never
 * overwritten.
 *
 * @param {{root: string, runAt: string, source: object}} backup - Run state.
 * @param {{stage: string, wabaId: string, live: object[], phase: 'before'|'after'|'manual'}} target
 * @returns {Promise.<string>} Folder of the backup set.
 */
async function backupTarget(backup, { stage, wabaId, live, phase }) {
    const directory = path.join(backup.root, backupSetName(wabaId, backup.runAt, phase));
    await mkdir(backup.root, { recursive: true });
    try {
        await mkdir(directory);
    } catch (ex) {
        throw ex.code === 'EEXIST' ? new Error(`backup set ${directory} already exists`) : ex;
    }
    const entries = live
        .map((template) => ({ template: normalizeTemplate(template), status: template.status }))
        .toSorted((a, b) => templateKey(a.template).localeCompare(templateKey(b.template)));
    const templates = entries.map((item) => item.template);
    for (const template of templates) {
        await writeTemplateFile(directory, template);
    }
    const { version } = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const manifest = {
        tool: 'waba-devtools',
        version,
        createdAt: new Date().toISOString(),
        runAt: backup.runAt,
        phase,
        wabaId,
        stage,
        source: backup.source,
        templates: entries.map(({ template, status }) => ({
            name: template.name,
            language: template.language,
            category: template.category,
            status,
        })),
    };
    await writeFile(
        path.join(directory, 'manifest.json'),
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
 * Creates restore points without deploying: one backup set `<wabaId>_<time>_manual` per WABA.
 *
 * @param {CommonOptions & {stage?: string, wabaIds?: string[], backupDir: string}} options
 * @returns {Promise.<object>} Report.
 */
export async function createBackup(options) {
    const { config, stage, wabaIds = [], backupDir } = options;
    if (!backupDir) {
        throw new UsageError('Missing --backup <folder>.');
    }
    if (!stage && wabaIds.length === 0) {
        throw new UsageError('Missing --stage or --waba.');
    }
    const backup = { root: backupDir, runAt: new Date().toISOString(), source: { type: 'manual' } };
    const sets = [];
    const targets = pickTargetWabas(config, stage, wabaIds, 'add --stage <stage>');
    for (const { stage: stageName, stages, entry } of targets) {
        const result = { stage: stageName, stages, wabaId: entry.wabaId };
        sets.push(result);
        try {
            const live = await clientFor(entry, options).listTemplates(entry.wabaId);
            result.backup = await backupTarget(backup, {
                stage: stageName,
                wabaId: entry.wabaId,
                live,
                phase: 'manual',
            });
            result.templateCount = live.length;
        } catch (ex) {
            result.error = describeError(ex);
        }
    }
    return { command: 'backup', sets, ok: sets.every((set) => !set.error) };
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
