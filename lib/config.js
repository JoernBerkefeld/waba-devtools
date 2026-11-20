import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { UsageError } from './errors.js';

export const CONFIG_FILE = '.wabadevrc.json';
export const DEFAULT_GRAPH_VERSION = 'v23.0';
export const DEFAULT_TEMPLATES_DIR = 'templates';

/**
 * @typedef {object} WabaEntry
 * @property {string} wabaId - WhatsApp Business Account ID.
 * @property {string} tokenEnv - Name of the environment variable that holds the access token.
 */

/**
 * @typedef {object} Config
 * @property {string} graphVersion - Graph API version, e.g. `v23.0`.
 * @property {string} templatesDir - Absolute path of the template folder.
 * @property {Object.<string, WabaEntry[]>} stages - Stage name to its WABAs.
 */

/**
 * Loads `.env` from the project root into `process.env`. Variables that are already set win.
 *
 * @param {string} cwd - Project root.
 * @param {NodeJS.ProcessEnv} [environment] - Environment to fill (default `process.env`).
 * @returns {string[]} Names of the variables that were set from the file.
 */
export function loadDotenvFile(cwd, environment = process.env) {
    const file = path.join(cwd, '.env');
    if (!existsSync(file)) {
        return [];
    }
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    const loaded = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (environment[key] !== undefined) {
            continue;
        }

        environment[key] = value;
        loaded.push(key);
    }
    return loaded;
}

/**
 * Reads and validates `.wabadevrc.json`.
 *
 * @param {string} cwd - Project root.
 * @returns {Config}
 */
export function loadConfig(cwd) {
    const file = path.join(cwd, CONFIG_FILE);
    if (!existsSync(file)) {
        throw new UsageError(`No ${CONFIG_FILE} found in ${cwd}. See the README for its format.`);
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (ex) {
        throw new UsageError(`${CONFIG_FILE} is not valid JSON: ${ex.message}`);
    }
    return validateConfig(raw, cwd);
}

/**
 * @param {any} raw - Parsed config file.
 * @param {string} cwd - Project root, used to resolve `templatesDir`.
 * @returns {Config}
 */
export function validateConfig(raw, cwd) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new UsageError(`${CONFIG_FILE} must contain a JSON object.`);
    }
    const graphVersion = raw.graphVersion ?? DEFAULT_GRAPH_VERSION;
    if (typeof graphVersion !== 'string' || !/^v\d+\.\d+$/.test(graphVersion)) {
        throw new UsageError(`${CONFIG_FILE}: graphVersion must look like "v23.0".`);
    }
    const templatesFolder = raw.templatesDir ?? DEFAULT_TEMPLATES_DIR;
    if (typeof templatesFolder !== 'string' || templatesFolder === '') {
        throw new UsageError(`${CONFIG_FILE}: templatesDir must be a non-empty string.`);
    }
    if (!raw.stages || typeof raw.stages !== 'object' || Array.isArray(raw.stages)) {
        throw new UsageError(`${CONFIG_FILE}: "stages" must be an object of stage name to WABAs.`);
    }
    const stages = {};
    for (const [stage, entries] of Object.entries(raw.stages)) {
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new UsageError(`${CONFIG_FILE}: stage "${stage}" needs at least one WABA entry.`);
        }
        stages[stage] = entries.map((entry, index) => {
            const where = `stage "${stage}", entry ${index + 1}`;
            if (!entry || typeof entry.wabaId !== 'string' || !/^\d+$/.test(entry.wabaId)) {
                throw new UsageError(`${CONFIG_FILE}: ${where}: wabaId must be a numeric string.`);
            }
            if (typeof entry.tokenEnv !== 'string' || !/^[A-Za-z_]\w*$/.test(entry.tokenEnv)) {
                throw new UsageError(
                    `${CONFIG_FILE}: ${where}: tokenEnv must be an environment variable name.`,
                );
            }
            return { wabaId: entry.wabaId, tokenEnv: entry.tokenEnv };
        });
    }
    return { graphVersion, templatesDir: path.resolve(cwd, templatesFolder), stages };
}

/**
 * @param {Config} config
 * @param {string} name - Stage name.
 * @returns {WabaEntry[]}
 */
export function getStage(config, name) {
    const entries = config.stages[name];
    if (!entries) {
        const known = Object.keys(config.stages).join(', ');
        throw new UsageError(`Unknown stage "${name}". Stages in ${CONFIG_FILE}: ${known}.`);
    }
    return entries;
}

/**
 * Picks the one WABA of a stage that serves as a source.
 *
 * @param {Config} config
 * @param {string} stage
 * @param {string} [wabaId] - `--from-waba`; required when the stage has several WABAs.
 * @returns {WabaEntry}
 */
export function pickSourceWaba(config, stage, wabaId) {
    const entries = getStage(config, stage);
    if (wabaId) {
        const entry = entries.find((candidate) => candidate.wabaId === wabaId);
        if (!entry) {
            throw new UsageError(`WABA ${wabaId} is not part of stage "${stage}".`);
        }
        return entry;
    }
    if (entries.length > 1) {
        const ids = entries.map((entry) => entry.wabaId).join(', ');
        throw new UsageError(
            `Stage "${stage}" has several WABAs (${ids}); pick one with --from-waba.`,
        );
    }
    return entries[0];
}

/**
 * The WABAs of a target stage: all of them, or only the ones named with `--to-waba`.
 *
 * @param {Config} config
 * @param {string} stage
 * @param {string[]} [wabaIds] - `--to-waba` values; empty means all.
 * @returns {WabaEntry[]}
 */
export function pickTargetWabas(config, stage, wabaIds = []) {
    const entries = getStage(config, stage);
    if (wabaIds.length === 0) {
        return entries;
    }
    const known = new Set(entries.map((entry) => entry.wabaId));
    const unknown = wabaIds.filter((wabaId) => !known.has(wabaId));
    if (unknown.length > 0) {
        throw new UsageError(`WABA ${unknown.join(', ')} is not part of stage "${stage}".`);
    }
    const wanted = new Set(wabaIds);
    return entries.filter((entry) => wanted.has(entry.wabaId));
}

/**
 * Reads the token of a WABA entry from the environment.
 *
 * @param {WabaEntry} entry
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string}
 */
export function resolveToken(entry, environment = process.env) {
    const token = environment[entry.tokenEnv];
    if (!token) {
        throw new UsageError(
            `Environment variable ${entry.tokenEnv} (token for WABA ${entry.wabaId}) is not set.`,
        );
    }
    return token;
}
