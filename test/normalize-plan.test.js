import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    assertSafeIdentity,
    comparableContent,
    mergeBody,
    normalizeTemplate,
    unsupportedReason,
} from '../lib/normalize.js';
import { planDeploy } from '../lib/plan.js';
import { bodyTemplate } from './helpers.js';

const live = (template, extra = {}) => ({ id: '1', status: 'APPROVED', ...template, ...extra });

describe('normalizeTemplate', () => {
    it('drops read-only fields and sorts keys', () => {
        const normalized = normalizeTemplate({
            status: 'APPROVED',
            id: '77',
            quality_score: { score: 'GREEN' },
            rejected_reason: 'NONE',
            previous_category: 'MARKETING',
            components: [{ text: 'Hi', type: 'BODY' }],
            language: 'fr',
            name: 'hello',
            category: 'utility',
        });
        assert.deepEqual(normalized, {
            category: 'UTILITY',
            components: [{ text: 'Hi', type: 'BODY' }],
            language: 'fr',
            name: 'hello',
        });
        assert.deepEqual(Object.keys(normalized), ['category', 'components', 'language', 'name']);
    });

    it('ignores category and a missing parameter_format when comparing', () => {
        const a = normalizeTemplate(bodyTemplate('x', 'fr', 'Hi'));
        const b = normalizeTemplate({ ...bodyTemplate('x', 'fr', 'Hi'), category: 'MARKETING' });
        const c = normalizeTemplate({
            ...bodyTemplate('x', 'fr', 'Hi'),
            parameter_format: undefined,
        });
        assert.equal(comparableContent(a), comparableContent(b));
        assert.equal(comparableContent(a), comparableContent(c));
    });

    it('names unsupported template kinds', () => {
        assert.match(
            unsupportedReason({ category: 'AUTHENTICATION', components: [] }),
            /authentication/,
        );
        assert.match(unsupportedReason({ components: [{ type: 'CAROUSEL' }] }), /carousel/);
        assert.match(
            unsupportedReason({ components: [{ type: 'HEADER', format: 'IMAGE' }] }),
            /media headers/,
        );
        assert.equal(
            unsupportedReason({ components: [{ type: 'HEADER', format: 'TEXT', text: 'x' }] }),
            undefined,
        );
    });

    it('rejects names that are unsafe as file names', () => {
        assert.throws(() => assertSafeIdentity({ name: '../x', language: 'fr' }), /letters/);
        assert.throws(() => assertSafeIdentity({ name: 'ok', language: 'fr/..' }), /letters/);
        assert.doesNotThrow(() => assertSafeIdentity({ name: 'wa_rs_v2', language: 'en_US' }));
    });

    it('mergeBody keeps header, footer and buttons in order', () => {
        const base = normalizeTemplate({
            ...bodyTemplate('x', 'fr', 'old'),
            components: [
                { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'OK' }] },
                { type: 'BODY', text: 'old' },
                { type: 'HEADER', format: 'TEXT', text: 'Head' },
            ],
        });
        const merged = mergeBody(base, normalizeTemplate(bodyTemplate('x', 'fr', 'new')));
        assert.deepEqual(
            merged.components.map((component) => component.type),
            ['HEADER', 'BODY', 'BUTTONS'],
        );
        assert.equal(merged.components[1].text, 'new');
        assert.equal(merged.category, 'UTILITY');
    });
});

/**
 * @param {object} template
 * @param {boolean} [isBodyOnly]
 * @returns {object}
 */
function source(template, isBodyOnly) {
    return { template: normalizeTemplate(template), bodyOnly: isBodyOnly };
}

describe('planDeploy', () => {
    it('covers create, unchanged, update, blocked and skipped', () => {
        const actions = planDeploy({
            source: [
                source(bodyTemplate('new_one', 'fr', 'Hi')),
                source(bodyTemplate('same', 'fr', 'Same')),
                source(bodyTemplate('changed', 'fr', 'New text')),
                source(bodyTemplate('pending', 'fr', 'New text')),
                source({
                    ...bodyTemplate('media', 'fr', 'x'),
                    components: [{ type: 'HEADER', format: 'VIDEO' }],
                }),
            ],
            target: [
                live(bodyTemplate('same', 'fr', 'Same'), { id: '2' }),
                live(bodyTemplate('changed', 'fr', 'Old text'), { id: '3', status: 'REJECTED' }),
                live(bodyTemplate('pending', 'fr', 'Old text'), { id: '4', status: 'PENDING' }),
            ],
        });
        assert.deepEqual(
            actions.map((action) => [action.name, action.action]),
            [
                ['new_one', 'create'],
                ['same', 'unchanged'],
                ['changed', 'update'],
                ['pending', 'blocked'],
                ['media', 'skipped'],
            ],
        );
        assert.equal(actions[0].body.category, 'UTILITY');
        assert.equal(actions[2].templateId, '3');
        assert.equal(actions[2].body.category, undefined, 'category is never sent on update');
    });

    it('treats a category-only difference as unchanged with a note', () => {
        const [action] = planDeploy({
            source: [source(bodyTemplate('x', 'fr', 'Hi'))],
            target: [live({ ...bodyTemplate('x', 'fr', 'Hi'), category: 'MARKETING' })],
        });
        assert.equal(action.action, 'unchanged');
        assert.match(action.note, /category MARKETING in target/);
    });

    it('is idempotent: templates retrieved from a WABA plan as unchanged against it', () => {
        const target = [
            live(bodyTemplate('a', 'fr', 'A {{1}}', { quality_score: { score: 'GREEN' } }), {
                id: '1',
            }),
            live(
                {
                    ...bodyTemplate('b', 'it', 'B'),
                    components: [
                        { type: 'HEADER', format: 'TEXT', text: 'H' },
                        { type: 'BODY', text: 'B' },
                        {
                            type: 'BUTTONS',
                            buttons: [{ type: 'URL', text: 'Go', url: 'https://x' }],
                        },
                    ],
                },
                { id: '2' },
            ),
        ];
        const retrieved = target.map((template) => ({ template: normalizeTemplate(template) }));
        const actions = planDeploy({ source: retrieved, target, fullSet: true });
        assert.deepEqual(
            actions.map((action) => action.action),
            ['unchanged', 'unchanged'],
        );
    });

    it('CSV body-only rows keep the target buttons', () => {
        const target = [
            live({
                ...bodyTemplate('x', 'fr', 'Old'),
                components: [
                    { type: 'BODY', text: 'Old' },
                    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'OK' }] },
                ],
            }),
        ];
        const [action] = planDeploy({
            source: [source(bodyTemplate('x', 'fr', 'New'), true)],
            target,
        });
        assert.equal(action.action, 'update');
        assert.deepEqual(
            action.body.components.map((component) => component.type),
            ['BODY', 'BUTTONS'],
        );
        const [again] = planDeploy({
            source: [source(bodyTemplate('x', 'fr', 'Old'), true)],
            target,
        });
        assert.equal(again.action, 'unchanged');
    });

    it('never prunes target-only templates it cannot recreate', () => {
        const target = [
            live({ ...bodyTemplate('otp', 'fr', 'x'), category: 'AUTHENTICATION' }, { id: '6' }),
            live(
                {
                    ...bodyTemplate('promo', 'fr', 'x'),
                    components: [
                        { type: 'HEADER', format: 'IMAGE' },
                        { type: 'BODY', text: 'x' },
                    ],
                },
                { id: '7' },
            ),
        ];
        const actions = planDeploy({ source: [], target, fullSet: true, prune: true });
        assert.deepEqual(
            actions.map((action) => action.action),
            ['extra', 'extra'],
        );
        assert.match(actions[0].note, /kept: authentication/);
        assert.match(actions[1].note, /kept: media headers/);
    });

    it('lists target-only templates only for full sets, as delete with prune', () => {
        const target = [live(bodyTemplate('only_target', 'fr', 'x'), { id: '5' })];
        assert.deepEqual(planDeploy({ source: [], target }), []);
        assert.equal(planDeploy({ source: [], target, fullSet: true })[0].action, 'extra');
        const [del] = planDeploy({ source: [], target, fullSet: true, prune: true });
        assert.equal(del.action, 'delete');
        assert.equal(del.templateId, '5');
    });
});
