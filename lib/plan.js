import {
    EDITABLE_STATUSES,
    comparableContent,
    mergeBody,
    normalizeTemplate,
    templateKey,
    toCreateBody,
    toUpdateBody,
    unsupportedReason,
} from './normalize.js';

/**
 * @typedef {object} SourceTemplate
 * @property {import('./normalize.js').Template} template - Normalized template.
 * @property {boolean} [bodyOnly] - CSV row: only the BODY is authoritative.
 */

/**
 * @typedef {object} PlannedAction
 * @property {'create'|'update'|'unchanged'|'blocked'|'skipped'|'extra'|'delete'} action
 * @property {string} name
 * @property {string} language
 * @property {string} [status] - Live status in the target before deploying.
 * @property {string} [templateId] - Live template ID in the target.
 * @property {object} [body] - Request body for create/update.
 * @property {string} [note] - Why blocked/skipped, or a category difference.
 */

/**
 * Decides what to do per template for one target WABA. Pure: no I/O.
 *
 * @param {object} input
 * @param {SourceTemplate[]} input.source - What should be in the target.
 * @param {object[]} input.target - Live templates of the target WABA (raw Graph objects).
 * @param {boolean} [input.fullSet] - Source is the complete set, so target-only templates count
 * as `extra` (and `delete` with prune).
 * @param {boolean} [input.prune] - Turn `extra` into `delete`.
 * @returns {PlannedAction[]}
 */
export function planDeploy({ source, target, fullSet = false, prune = false }) {
    const live = new Map(target.map((template) => [templateKey(template), template]));
    const actions = [];
    const sourceKeys = new Set();
    for (const { template, bodyOnly } of source) {
        const key = templateKey(template);
        sourceKeys.add(key);
        const base = { name: template.name, language: template.language };
        const existing = live.get(key);
        const reason =
            unsupportedReason(template) ??
            (existing ? unsupportedReason(normalizeTemplate(existing)) : undefined);
        if (reason) {
            actions.push({ ...base, action: 'skipped', note: reason, status: existing?.status });
            continue;
        }
        if (!existing) {
            actions.push({ ...base, action: 'create', body: toCreateBody(template) });
            continue;
        }
        const current = normalizeTemplate(existing);
        const desired = bodyOnly ? mergeBody(current, template) : template;
        const known = { ...base, status: existing.status, templateId: existing.id };
        const categoryNote =
            template.category && current.category && template.category !== current.category
                ? `category ${current.category} in target, ${template.category} in source (not changed)`
                : undefined;
        if (comparableContent(desired) === comparableContent(current)) {
            actions.push({ ...known, action: 'unchanged', note: categoryNote });
        } else if (EDITABLE_STATUSES.has(existing.status)) {
            actions.push({
                ...known,
                action: 'update',
                body: toUpdateBody(desired),
                note: categoryNote,
            });
        } else {
            actions.push({
                ...known,
                action: 'blocked',
                note: `status ${existing.status} cannot be edited`,
            });
        }
    }
    if (fullSet) {
        for (const [key, existing] of live) {
            if (sourceKeys.has(key)) {
                continue;
            }

            // Never delete what this tool cannot recreate (media, OTP, carousel).
            const reason = unsupportedReason(normalizeTemplate(existing));
            actions.push({
                name: existing.name,
                language: existing.language,
                status: existing.status,
                templateId: existing.id,
                action: prune && !reason ? 'delete' : 'extra',
                ...(reason && { note: `kept: ${reason}` }),
            });
        }
    }
    return actions;
}
