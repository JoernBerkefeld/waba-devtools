import path from 'node:path';
import { getStage, pickSourceWaba, pickTargetWabas, resolveToken } from './config.js';
import { readCsvTemplates } from './csv.js';
import { GraphError, UsageError } from './errors.js';
import {
    readTemplateDirectory,
    readTemplateFile,
    templatePath,
    writeTemplateFile,
} from './files.js';
import { createGraphClient } from './graph.js';
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
    const { stage, entry } = pickSourceWaba(config, from, fromWaba);
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
    return { command: 'retrieve', stage, wabaId: entry.wabaId, files, ok: true };
}

/**
 * Writes CSV rows into template files. Only the body (and, for new files, the category) comes
 * from the CSV; header, footer and buttons of existing files are kept.
 *
 * @param {CommonOptions & {csv: string}} options
 * @returns {Promise.<object>} Report.
 */
export async function importCsv({ config, cwd, csv }) {
    const { templates, errors } = await readCsvTemplates(path.resolve(cwd, csv));
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
    return { command: 'import', csv, files, rowErrors: errors, ok: errors.length === 0 };
}

/**
 * Loads what should be deployed: CSV rows, a live source WABA, or the templates folder.
 *
 * @param {CommonOptions & {from?: string, fromWaba?: string, csv?: string}} options
 * @returns {Promise.<{source: import('./plan.js').SourceTemplate[], description: object, rowErrors: object[]}>}
 */
async function loadSource(options) {
    const { config, cwd, from, fromWaba, csv } = options;
    if (csv) {
        const { templates, errors } = await readCsvTemplates(path.resolve(cwd, csv));
        return {
            source: templates.map((template) => ({ template, bodyOnly: true })),
            description: { type: 'csv', csv },
            rowErrors: errors,
        };
    }
    if (from || fromWaba) {
        const { stage, entry } = pickSourceWaba(config, from, fromWaba);
        const live = await clientFor(entry, options).listTemplates(entry.wabaId);
        return {
            source: live.map((template) => ({ template: normalizeTemplate(template) })),
            description: { type: 'waba', stage, wabaId: entry.wabaId },
            rowErrors: [],
        };
    }
    const templates = await readTemplateDirectory(config.templatesDir);
    return {
        source: templates.map((template) => ({ template })),
        description: { type: 'files', dir: path.relative(cwd, config.templatesDir) || '.' },
        rowErrors: [],
    };
}

/**
 * Creates missing and updates changed templates in every WABA of the target stage.
 *
 * @param {CommonOptions & {
 *   to?: string, toWabas?: string[], from?: string, fromWaba?: string, csv?: string,
 *   names?: string[],
 *   dryRun?: boolean, prune?: boolean, yes?: boolean
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
    } = options;
    if (csv && (from || fromWaba)) {
        throw new UsageError('Use either --csv or --from/--from-waba as the source, not both.');
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
    for (const { stage, entry } of targets) {
        const target = { stage, wabaId: entry.wabaId, actions: [] };
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
        for (const plannedAction of planned) {
            const { body, ...action } = plannedAction;
            target.actions.push(action);
            if (dryRun || !['create', 'update', 'delete'].includes(action.action)) {
                continue;
            }
            if (!yes && action.action === 'delete') {
                action.result = 'not run (add --yes)';
                continue;
            }
            try {
                if (action.action === 'create') {
                    const response = await client.createTemplate(entry.wabaId, body);
                    action.templateId = response.id;
                    action.statusAfter = response.status;
                } else if (action.action === 'update') {
                    await client.updateTemplate(action.templateId, body);
                } else {
                    await client.deleteTemplate(entry.wabaId, action.name, action.templateId);
                }
                action.result = 'done';
            } catch (ex) {
                action.result = 'failed';
                action.error = describeError(ex);
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
