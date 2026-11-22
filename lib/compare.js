import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pickTargetWabas, parseJson, resolveToken } from './config.js';
import { UsageError } from './errors.js';
import { readTemplateDirectory } from './files.js';
import { createGraphClient } from './graph.js';
import {
    comparableContent,
    normalizeNewlines,
    normalizeTemplate,
    templateKey,
} from './normalize.js';

/**
 * @typedef {object} FieldChange
 * @property {string} field - Readable field name, e.g. `Body text` or `Button 2 (URL) – URL`.
 * @property {string} [before] - Value in the older set (missing = the field did not exist).
 * @property {string} [after] - Value in the newer set (missing = the field was removed).
 */

/**
 * Compares two backup sets (restore points). The older one (by `createdAt` in its manifest) is
 * always "before", whatever order they are given in, so a removed template never looks added.
 *
 * @param {string} setA - Backup set folder.
 * @param {string} setB - Backup set folder.
 * @returns {Promise.<object>} Report: before (the older set), after (the newer set), added, removed, changed (with field changes),
 * unchanged count.
 */
export async function compareBackups(setA, setB) {
    const [first, second] = await Promise.all([readSet(setA), readSet(setB)]);
    return isOlder(second, first) ? compareSets(second, first) : compareSets(first, second);
}

/**
 * Compares a backup set with what is in a WABA right now. The live state is read into memory only and
 * never saved. The WABA is the one the backup was taken from, unless `wabaId` names another one
 * (it must be in the config, for its token).
 *
 * @param {object} options
 * @param {import('./config.js').Config} options.config
 * @param {NodeJS.ProcessEnv} [options.environment]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} options.set - Backup set folder.
 * @param {string} [options.wabaId] - Live WABA (default: the backup's WABA).
 * @returns {Promise.<object>} Report like `compareBackups`; `after` is the live WABA.
 */
export async function compareWithLive({
    config,
    environment = process.env,
    fetchImpl,
    set,
    wabaId,
}) {
    const backup = await readSet(set);
    const now = await liveSet(liveTarget(config, backup.info, wabaId), {
        config,
        environment,
        fetchImpl,
    });
    return compareSets(backup, now);
}

/**
 * Compares two WABAs as they are right now. Both are read into memory only, nothing is saved. There is
 * no time order here: the caller says which WABA counts as "before" and which as "after".
 *
 * @param {object} options
 * @param {import('./config.js').Config} options.config
 * @param {NodeJS.ProcessEnv} [options.environment]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} options.beforeWaba - WABA ID shown as "before".
 * @param {string} options.afterWaba - WABA ID shown as "after".
 * @returns {Promise.<object>} Report like `compareBackups`; `before` and `after` as chosen.
 */
export async function compareWabas({
    config,
    environment = process.env,
    fetchImpl,
    beforeWaba,
    afterWaba,
}) {
    if (!beforeWaba || !afterWaba) {
        throw new UsageError('Give both --before-waba and --after-waba.');
    }
    if (beforeWaba === afterWaba) {
        throw new UsageError('Pick two different WABAs to compare.');
    }
    const hint = 'list it in one stage only';
    const [before, after] = await Promise.all(
        [beforeWaba, afterWaba].map((wabaId) =>
            liveSet(pickTargetWabas(config, undefined, [wabaId], hint)[0], {
                config,
                environment,
                fetchImpl,
            }),
        ),
    );
    return compareSets(before, after);
}

/**
 * A WABA's templates right now, shaped like a backup set (in memory only).
 *
 * @param {{stage: string, entry: import('./config.js').WabaEntry}} target
 * @param {{config: import('./config.js').Config, environment: NodeJS.ProcessEnv, fetchImpl?: typeof fetch}} io
 * @returns {Promise.<{info: object, templates: object[], status: Map.<string, string>}>}
 */
async function liveSet({ stage, entry }, { config, environment, fetchImpl }) {
    const client = createGraphClient({
        token: resolveToken(entry, environment),
        version: config.graphVersion,
        fetchImpl,
    });
    const live = await client.listTemplates(entry.wabaId);
    return {
        info: { wabaId: entry.wabaId, stage, createdAt: new Date().toISOString(), phase: 'live' },
        templates: live.map((template) => normalizeTemplate(template)),
        status: new Map(live.map((template) => [templateKey(template), template.status])),
    };
}

/**
 * The live WABA and its config entry (for the token). Without `wabaId`, the backup's own WABA in the
 * backup's own stage, so a WABA listed in several stages with different tokens still works.
 *
 * @param {import('./config.js').Config} config
 * @param {{wabaId: string, stage?: string}} info - Backup set info.
 * @param {string} [wabaId] - Another WABA.
 * @returns {{stage: string, entry: import('./config.js').WabaEntry}}
 */
function liveTarget(config, info, wabaId) {
    const ownStage = config.stages[info.stage];
    return !wabaId && ownStage?.some((entry) => entry.wabaId === info.wabaId)
        ? pickTargetWabas(config, info.stage, [info.wabaId])[0]
        : pickTargetWabas(
              config,
              undefined,
              [wabaId ?? info.wabaId],
              'list it in one stage only, or use a backup taken from that stage',
          )[0];
}

/**
 * @param {{info: object, templates: object[], status: Map.<string, string>}} older
 * @param {{info: object, templates: object[], status: Map.<string, string>}} newer
 * @returns {object} Compare report.
 */
function compareSets(older, newer) {
    const before = new Map(older.templates.map((template) => [templateKey(template), template]));
    const after = new Map(newer.templates.map((template) => [templateKey(template), template]));
    const added = [];
    const removed = [];
    const changed = [];
    let unchanged = 0;
    for (const [key, template] of after) {
        if (!before.has(key)) {
            added.push(summary(template, newer));
        }
    }
    for (const [key, template] of before) {
        const next = after.get(key);
        if (!next) {
            removed.push(summary(template, older));
            continue;
        }
        const changes = fieldChanges(template, next);
        if (changes.length === 0) {
            unchanged++;
        } else {
            changed.push({ ...summary(next, newer), statusBefore: older.status.get(key), changes });
        }
    }
    return {
        command: 'compare',
        before: older.info,
        after: newer.info,
        sameWaba: older.info.wabaId === newer.info.wabaId,
        added: added.toSorted(byKey),
        removed: removed.toSorted(byKey),
        changed: changed.toSorted(byKey),
        unchanged,
        ok: true,
    };
}

/**
 * Sort order: name, then language.
 *
 * @param {{name: string, language: string}} a
 * @param {{name: string, language: string}} b
 * @returns {number}
 */
function byKey(a, b) {
    return templateKey(a).localeCompare(templateKey(b));
}

/**
 * Button settings shown as their own fields; anything else ends up in "other settings".
 */
const KNOWN_BUTTON_KEYS = new Set(['type', 'text', 'url', 'example', 'phone_number']);

/**
 * @param {{info: {createdAt: string, phase?: string}}} a
 * @param {{info: {createdAt: string, phase?: string}}} b
 * @returns {boolean} True when `a` was taken before `b`.
 */
function isOlder(a, b) {
    return a.info.createdAt === b.info.createdAt
        ? a.info.phase === 'before' && b.info.phase === 'after'
        : a.info.createdAt < b.info.createdAt;
}

/**
 * Reads a backup set: its manifest and its templates.
 *
 * @param {string} directory
 * @returns {Promise.<{info: object, templates: object[], status: Map.<string, string>}>}
 */
async function readSet(directory) {
    let manifest;
    try {
        manifest = parseJson(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    } catch (ex) {
        throw new UsageError(
            `${directory} is not a backup set (no readable manifest.json): ${ex.message}`,
        );
    }
    if (manifest.tool !== 'waba-devtools' || !manifest.createdAt || !manifest.wabaId) {
        throw new UsageError(`${directory}: manifest.json is not a waba-devtools backup manifest.`);
    }
    const templates = await readTemplateDirectory(directory);
    const status = new Map(
        (manifest.templates ?? []).map((template) => [templateKey(template), template.status]),
    );
    return {
        info: {
            dir: directory,
            wabaId: manifest.wabaId,
            stage: manifest.stage,
            createdAt: manifest.createdAt,
            phase: manifest.phase,
        },
        templates,
        status,
    };
}

/**
 * @param {object} template
 * @param {{status: Map.<string, string>}} set
 * @returns {{name: string, language: string, category?: string, status?: string}}
 */
function summary(template, set) {
    return {
        name: template.name,
        language: template.language,
        category: template.category,
        status: set.status.get(templateKey(template)),
    };
}

/**
 * Field-by-field differences, with readable field names. Line endings do not count. If the templates
 * differ in a way no named field shows, one "Other settings" change is reported, so a real change is
 * never listed as unchanged.
 *
 * @param {object} before
 * @param {object} after
 * @returns {FieldChange[]}
 */
export function fieldChanges(before, after) {
    const old = readableFields(before);
    const next = readableFields(after);
    const changes = [];
    const allFields = new Set([...old.keys(), ...next.keys()]);
    for (const field of allFields) {
        if (old.get(field) !== next.get(field)) {
            changes.push({ field, before: old.get(field), after: next.get(field) });
        }
    }
    if (changes.length === 0 && comparableContent(before) !== comparableContent(after)) {
        changes.push({
            field: 'Other settings',
            before: comparableContent(before),
            after: comparableContent(after),
        });
    }
    return changes;
}

/**
 * Shows a list of values: joined with ", " when that is unambiguous, otherwise as JSON.
 *
 * @param {string[]|undefined} values
 * @returns {string|undefined}
 */
function listText(values) {
    if (!Array.isArray(values)) {
        return values;
    }
    const isPlain = values.every((value) => typeof value === 'string' && !value.includes(', '));
    return isPlain ? values.join(', ') : JSON.stringify(values);
}

/**
 * Settings of a part that have no field of their own, as one JSON value.
 *
 * @param {object} object
 * @param {Set.<string>} known - Keys already shown as fields.
 * @returns {object|undefined}
 */
function otherSettings(object, known) {
    const rest = Object.fromEntries(
        Object.entries(object ?? {}).filter(([key]) => !known.has(key)),
    );
    return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Flattens a template into readable field names and text values.
 *
 * @param {object} template
 * @returns {Map.<string, string>}
 */
function readableFields(template) {
    const fields = new Map();
    const put = (field, value) => {
        if (![undefined, null, ''].includes(value)) {
            fields.set(field, typeof value === 'string' ? value : JSON.stringify(value));
        }
    };
    const clean = normalizeNewlines(template);
    put('Category', clean.category);
    put('Variable format', clean.parameter_format ?? 'POSITIONAL');
    const components = clean.components ?? [];
    for (const component of components) {
        addComponentFields(component, put);
    }
    return fields;
}

const PART_KEYS = new Set(['type', 'format', 'text', 'example']);
const HEADER_EXAMPLE_KEYS = new Set(['header_text', 'header_handle', 'header_text_named_params']);
const BODY_EXAMPLE_KEYS = new Set(['body_text', 'body_text_named_params']);

/**
 * @param {object} component
 * @param {(field: string, value: any) => void} put
 * @returns {void}
 */
function addComponentFields(component, put) {
    switch (component.type) {
        case 'HEADER': {
            put('Header type', component.format);
            put('Header text', component.text);
            put('Header example', listText(component.example?.header_text));
            put('Header media example', listText(component.example?.header_handle));
            put('Header named examples', component.example?.header_text_named_params);
            put('Header – other settings', otherSettings(component, PART_KEYS));
            put(
                'Header example – other settings',
                otherSettings(component.example, HEADER_EXAMPLE_KEYS),
            );
            break;
        }
        case 'BODY': {
            const rows = component.example?.body_text ?? [];
            put('Body text', component.text);
            put('Body examples', rows.length > 1 ? JSON.stringify(rows) : listText(rows[0]));
            put('Body named examples', component.example?.body_text_named_params);
            put('Body – other settings', otherSettings(component, PART_KEYS));
            put(
                'Body example – other settings',
                otherSettings(component.example, BODY_EXAMPLE_KEYS),
            );
            break;
        }
        case 'FOOTER': {
            put('Footer text', component.text);
            put('Footer – other settings', otherSettings(component, PART_KEYS));
            break;
        }
        case 'BUTTONS': {
            const buttons = component.buttons ?? [];
            for (const [index, button] of buttons.entries()) {
                const label = `Button ${index + 1} (${button.type})`;
                put(`${label} – text`, button.text);
                put(`${label} – URL`, button.url);
                put(`${label} – URL example`, listText(button.example));
                put(`${label} – phone number`, button.phone_number);
                put(`${label} – other settings`, otherSettings(button, KNOWN_BUTTON_KEYS));
            }
            break;
        }
        default: {
            put(`${component.type} (other part)`, component);
        }
    }
}
