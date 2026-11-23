import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson } from './config.js';
import { UsageError } from './errors.js';
import { assertSafeIdentity, normalizeTemplate, templateKey } from './normalize.js';

/**
 * Path of a template file: `<directory>/<name>/<language>.json`.
 *
 * @param {string} directory - Templates folder.
 * @param {{name: string, language: string}} template
 * @returns {string}
 */
export function templatePath(directory, template) {
    assertSafeIdentity(template);
    return path.join(directory, template.name, `${template.language}.json`);
}

/**
 * Stable file content: sorted keys, 4-space indent, LF, final newline.
 *
 * @param {object} template - Normalized template.
 * @returns {string}
 */
export function serializeTemplate(template) {
    return `${JSON.stringify(template, undefined, 4)}\n`;
}

/**
 * Reads one template file, or `undefined` when it does not exist.
 *
 * @param {string} directory
 * @param {{name: string, language: string}} identity
 * @returns {Promise.<import('./normalize.js').Template | undefined>}
 */
export async function readTemplateFile(directory, identity) {
    const file = templatePath(directory, identity);
    return existsSync(file)
        ? normalizeTemplate(parseJson(await readFile(file, 'utf8')))
        : undefined;
}

/**
 * Writes a template file.
 *
 * @param {string} directory
 * @param {import('./normalize.js').Template} template - Normalized template.
 * @returns {Promise.<'created' | 'updated' | 'unchanged'>}
 */
export async function writeTemplateFile(directory, template) {
    const file = templatePath(directory, template);
    const content = serializeTemplate(template);
    let previous;
    if (existsSync(file)) {
        previous = await readFile(file, 'utf8');
        if (previous === content) {
            return 'unchanged';
        }
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return previous === undefined ? 'created' : 'updated';
}

/**
 * Reads all templates below `directory`. File and folder names must match the content.
 *
 * @param {string} directory
 * @returns {Promise.<import('./normalize.js').Template[]>}
 */
export async function readTemplateDirectory(directory) {
    if (!existsSync(directory)) {
        throw new UsageError(
            `Templates folder ${directory} does not exist. Run "waba retrieve" first.`,
        );
    }
    const templates = [];
    const folders = await readdir(directory, { withFileTypes: true });
    for (const folder of folders) {
        if (!folder.isDirectory()) {
            continue;
        }
        const folderPath = path.join(directory, folder.name);
        const files = await readdir(folderPath, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.json')) {
                continue;
            }
            const relative = `${folder.name}/${file.name}`;
            let parsed;
            try {
                parsed = parseJson(await readFile(path.join(folderPath, file.name), 'utf8'));
            } catch (ex) {
                throw new UsageError(`${relative} is not valid JSON: ${ex.message}`);
            }
            const template = normalizeTemplate(parsed);
            if (
                template.name !== folder.name ||
                `${template.language}.json` !== file.name ||
                !template.category
            ) {
                throw new UsageError(
                    `${relative} must contain name "${folder.name}", the language of its file ` +
                        `name and a category.`,
                );
            }
            templates.push(template);
        }
    }
    return templates.toSorted((a, b) => templateKey(a).localeCompare(templateKey(b)));
}
