import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../lib/cli.js';
import { bodyTemplate, createFakeGraph, createRunRoot } from './helpers.js';

const run = createRunRoot();
after(() => run.cleanup());

const ENV = { T_DEV: 'tok-dev', T_QA: 'tok-qa', T_PROD: 'tok-prod' };

/**
 * Temp project with config, fake Graph (dev=1, qa=2, prod=3+4) and a CLI runner.
 *
 * @param {object} [templates] - Templates per WABA id.
 * @returns {object}
 */
function project(templates = {}) {
    const cwd = run.add(`project-${randomUUID()}`);
    mkdirSync(cwd);
    writeFileSync(
        path.join(cwd, '.wabadevrc.json'),
        JSON.stringify({
            stages: {
                dev: [{ wabaId: '1', tokenEnv: 'T_DEV' }],
                qa: [{ wabaId: '2', tokenEnv: 'T_QA' }],
                prod: [
                    { wabaId: '3', tokenEnv: 'T_PROD' },
                    { wabaId: '4', tokenEnv: 'T_PROD' },
                ],
            },
        }),
    );
    const graph = createFakeGraph({
        wabas: {
            1: { token: 'tok-dev', templates: templates[1] },
            2: { token: 'tok-qa', templates: templates[2] },
            3: { token: 'tok-prod', templates: templates[3] },
            4: { token: 'tok-prod', templates: templates[4] },
        },
    });
    const cli = async (arguments_, environment = ENV) => {
        const out = [];
        const error = [];
        const code = await main(arguments_, {
            cwd,
            environment: { ...environment },
            out: (text) => {
                out.push(text);
            },
            err: (text) => {
                error.push(text);
            },
            fetchImpl: graph.fetchImpl,
        });
        return { code, out: out.join('\n'), err: error.join('\n') };
    };
    const writes = () => graph.calls.filter((call) => call.method !== 'GET');
    return { cwd, graph, cli, writes };
}

const json = (result) => JSON.parse(result.out);

describe('wabadev retrieve / deploy', () => {
    it('retrieves into files and deploys them to every WABA of a stage', async () => {
        const p = project({
            1: [
                bodyTemplate('welcome', 'fr', 'Bonjour {{1}}', {
                    components: [
                        { type: 'BODY', text: 'Bonjour {{1}}', example: { body_text: [['Ana']] } },
                    ],
                }),
                bodyTemplate('welcome', 'it', 'Ciao'),
            ],
            3: [bodyTemplate('welcome', 'it', 'Ciao vecchio')],
        });
        const retrieved = await p.cli(['retrieve', '--from', 'dev']);
        assert.equal(retrieved.code, 0, retrieved.err);
        const file = path.join(p.cwd, 'templates', 'welcome', 'fr.json');
        const content = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(content.id, undefined);
        assert.equal(content.status, undefined);

        const dry = json(await p.cli(['deploy', '--to', 'prod', '--dry-run', '--json']));
        assert.equal(p.writes().length, 0, 'dry run sends nothing');
        assert.deepEqual(
            dry.targets.map((target) => target.actions.map((action) => action.action)),
            [
                ['create', 'update'],
                ['create', 'create'],
            ],
        );
        assert.equal(dry.targets[0].actions[1].status, 'APPROVED');

        const deployed = json(await p.cli(['deploy', '--to', 'prod', '--json']));
        assert.equal(deployed.ok, true);
        assert.equal(deployed.targets[0].actions[0].statusAfter, 'PENDING');
        assert.equal(p.writes().length, 4);
        const updated = p.graph.wabas[3].templates.find((t) => t.language === 'it');
        assert.equal(updated.components[0].text, 'Ciao');
        assert.equal(updated.category, 'UTILITY');

        // Make the new templates approved, then deploy again: nothing may be sent.
        for (const waba of [p.graph.wabas[3], p.graph.wabas[4]]) {
            for (const template of waba.templates) {
                template.status = 'APPROVED';
            }
        }
        const before = p.writes().length;
        const again = json(await p.cli(['deploy', '--to', 'prod', '--json']));
        assert.equal(p.writes().length, before, 'second deploy sends no writes');
        assert.ok(
            again.targets.every((target) => target.actions.every((a) => a.action === 'unchanged')),
        );
    });

    it('deploys selected templates with -m and WABA to WABA with --from', async () => {
        const p = project({
            2: [
                bodyTemplate('a', 'fr', 'A'),
                bodyTemplate('b', 'fr', 'B'),
                bodyTemplate('b', 'de', 'B'),
            ],
        });
        const result = json(
            await p.cli(['deploy', '--from', 'qa', '--to', 'dev', '-m', 'b', '--json']),
        );
        assert.equal(result.ok, true);
        assert.deepEqual(result.source, {
            type: 'waba',
            stage: 'qa',
            stages: ['qa'],
            wabaId: '2',
        });
        assert.deepEqual(
            p.graph.wabas[1].templates
                .map((t) => `${t.name}/${t.language}`)
                .toSorted((a, b) => a.localeCompare(b)),
            ['b/de', 'b/fr'],
        );
        const missing = await p.cli(['deploy', '--from', 'qa', '--to', 'dev', '-m', 'nope']);
        assert.equal(missing.code, 2);
        assert.match(missing.err, /Not found in the source: nope/);
    });

    it('picks one source WABA with --from-waba and target WABAs with --to-waba', async () => {
        const p = project({
            3: [bodyTemplate('a', 'fr', 'A')],
            4: [bodyTemplate('b', 'fr', 'B')],
        });
        const ambiguous = await p.cli(['retrieve', '--from', 'prod']);
        assert.equal(ambiguous.code, 2);
        assert.match(ambiguous.err, /several WABAs \(3, 4\); pick one with --from-waba/);
        assert.equal(p.graph.calls.length, 0, 'nothing is read before the usage error');

        const retrieved = json(
            await p.cli(['retrieve', '--from', 'prod', '--from-waba', '4', '--json']),
        );
        assert.equal(retrieved.wabaId, '4');
        assert.deepEqual(
            retrieved.files.map((file) => file.name),
            ['b'],
        );

        // WABA 4 → WABA 3 only, inside the same stage; dev and qa stay untouched.
        const result = json(
            await p.cli([
                'deploy',
                '--from',
                'prod',
                '--from-waba',
                '4',
                '--to',
                'prod',
                '--to-waba',
                '3',
                '--json',
            ]),
        );
        assert.equal(result.ok, true);
        assert.deepEqual(
            result.targets.map((target) => target.wabaId),
            ['3'],
        );
        assert.deepEqual(
            p.graph.wabas[3].templates.map((t) => t.name).toSorted((a, b) => a.localeCompare(b)),
            ['a', 'b'],
        );
        assert.equal(p.writes().length, 1);

        const unknown = await p.cli(['deploy', '--to', 'prod', '--to-waba', '9']);
        assert.equal(unknown.code, 2);
        assert.match(unknown.err, /WABA 9 is not part of stage "prod"/);
        const noTarget = await p.cli(['deploy', '--from-waba', '3']);
        assert.equal(noTarget.code, 2);
        assert.match(noTarget.err, /Missing --to or --to-waba/);
        const mixed = await p.cli(['deploy', '--csv', 'x.csv', '--from-waba', '3', '--to', 'qa']);
        assert.equal(mixed.code, 2);
        assert.match(mixed.err, /Use only one source: --csv, --from\/--from-waba or --from-dir/);
        const old = await p.cli(['retrieve', '--from', 'prod', '--waba', '3']);
        assert.equal(old.code, 2);
        assert.equal(p.writes().length, 1, 'refused runs send nothing');
    });

    it('needs no stage when the WABA flags name the WABAs', async () => {
        const p = project({ 4: [bodyTemplate('b', 'fr', 'B')] });
        const retrieved = json(await p.cli(['retrieve', '--from-waba', '4', '--json']));
        assert.equal(retrieved.stage, 'prod');
        assert.equal(retrieved.wabaId, '4');
        assert.ok(existsSync(path.join(p.cwd, 'templates', 'b', 'fr.json')));

        // WABA 4 (prod) → WABA 2 (qa) and WABA 3 (prod), each with its own token.
        const result = json(
            await p.cli([
                'deploy',
                '--from-waba',
                '4',
                '--to-waba',
                '2',
                '--to-waba',
                '3',
                '--json',
            ]),
        );
        assert.equal(result.ok, true);
        assert.deepEqual(result.source, {
            type: 'waba',
            stage: 'prod',
            stages: ['prod'],
            wabaId: '4',
        });
        assert.deepEqual(
            result.targets.map((target) => `${target.stage}/${target.wabaId}`),
            ['qa/2', 'prod/3'],
        );
        assert.equal(p.graph.wabas[2].templates.length, 1);
        assert.equal(p.graph.wabas[3].templates.length, 1);
        assert.equal(p.graph.wabas[1].templates.length, 0, 'dev is untouched');

        // From the template files to one WABA, without --to.
        const files = json(await p.cli(['deploy', '--to-waba', '1', '--json']));
        assert.equal(files.source.type, 'files');
        assert.equal(p.graph.wabas[1].templates.length, 1);
    });

    it('refuses unknown and ambiguous WABAs and duplicates in a stage, without writes', async () => {
        const p = project({ 4: [bodyTemplate('b', 'fr', 'B')] });
        writeFileSync(
            path.join(p.cwd, '.wabadevrc.json'),
            JSON.stringify({
                stages: {
                    qa: [{ wabaId: '2', tokenEnv: 'T_QA' }],
                    prod: [
                        { wabaId: '3', tokenEnv: 'T_PROD' },
                        { wabaId: '4', tokenEnv: 'T_PROD' },
                        { wabaId: '3', tokenEnv: 'T_PROD' },
                    ],
                    special: [{ wabaId: '3', tokenEnv: 'T_QA' }],
                },
            }),
        );
        const ambiguous = await p.cli(['deploy', '--from-waba', '4', '--to-waba', '3']);
        assert.equal(ambiguous.code, 2);
        assert.match(ambiguous.err, /WABA 3 is in stages prod, special with different tokens/);
        const unknown = await p.cli(['deploy', '--from-waba', '4', '--to-waba', '9']);
        assert.equal(unknown.code, 2);
        assert.match(unknown.err, /WABA 9 is not in \.wabadevrc\.json/);
        assert.equal(p.writes().length, 0, 'refused runs send nothing');

        // WABA 3 is listed twice in prod: warned about and deployed once.
        const result = await p.cli(['deploy', '--from-waba', '4', '--to', 'prod', '--json']);
        assert.equal(result.code, 0);
        assert.match(result.err, /Warning: .*stage "prod" lists WABA 3 more than once/);
        assert.deepEqual(
            json(result).targets.map((target) => target.wabaId),
            ['3', '4'],
        );
        assert.equal(p.writes().length, 1, 'one create in WABA 3, nothing twice');
    });

    it('reports blocked templates and failed calls with exit code 1', async () => {
        const p = project({
            1: [bodyTemplate('pending', 'fr', 'New'), bodyTemplate('bad', 'fr', 'x')],
            2: [bodyTemplate('pending', 'fr', 'Old', { status: 'PENDING' })],
        });
        p.graph.wabas[2].failCreate = {
            bad: { message: 'Invalid parameter', code: 100, error_user_msg: 'Body is too short' },
        };
        const result = await p.cli(['deploy', '--from', 'dev', '--to', 'qa']);
        assert.equal(result.code, 1);
        assert.match(result.out, /blocked\s+pending \(fr\) \[PENDING\] — status PENDING/);
        assert.match(
            result.out,
            /create\s+bad \(fr\) failed — \(#100\) Invalid parameter — Body is too short/,
        );
    });
});

/**
 * Project where qa has one template more than dev.
 *
 * @returns {object}
 */
function setup() {
    return project({
        1: [bodyTemplate('keep', 'fr', 'K')],
        2: [bodyTemplate('keep', 'fr', 'K'), bodyTemplate('old', 'fr', 'O')],
    });
}

describe('wabadev --prune', () => {
    it('is refused with -m, with --csv and with an empty source', async () => {
        const p = setup();
        assert.match(
            (await p.cli(['deploy', '--to', 'qa', '--prune', '-m', 'keep'])).err,
            /full set/,
        );
        assert.match(
            (await p.cli(['deploy', '--to', 'qa', '--prune', '--csv', 'x.csv'])).err,
            /full set/,
        );
        mkdirSync(path.join(p.cwd, 'templates'));
        const empty = await p.cli(['deploy', '--to', 'qa', '--prune', '--yes']);
        assert.equal(empty.code, 2);
        assert.match(empty.err, /refusing --prune/);
        assert.equal(p.writes().length, 0);
    });

    it('only lists deletes without --yes and deletes with it', async () => {
        const p = setup();
        const listed = json(
            await p.cli(['deploy', '--from', 'dev', '--to', 'qa', '--prune', '--json']),
        );
        const del = listed.targets[0].actions.find((action) => action.action === 'delete');
        assert.equal(del.result, 'not run (add --yes)');
        assert.equal(p.writes().length, 0);

        const done = json(
            await p.cli(['deploy', '--from', 'dev', '--to', 'qa', '--prune', '--yes', '--json']),
        );
        assert.equal(done.ok, true);
        assert.deepEqual(
            p.graph.wabas[2].templates.map((t) => t.name),
            ['keep'],
        );
        const call = p.writes().find((c) => c.method === 'DELETE');
        assert.equal(call.query.name, 'old');
        assert.ok(call.query.hsm_id);
    });

    it('prunes only the WABAs named with --to-waba', async () => {
        const p = project({
            1: [bodyTemplate('keep', 'fr', 'K')],
            3: [bodyTemplate('keep', 'fr', 'K'), bodyTemplate('old', 'fr', 'O')],
            4: [bodyTemplate('keep', 'fr', 'K'), bodyTemplate('old', 'fr', 'O')],
        });
        const result = json(
            await p.cli([
                'deploy',
                '--from',
                'dev',
                '--to-waba',
                '3',
                '--prune',
                '--yes',
                '--json',
            ]),
        );
        assert.equal(result.ok, true);
        assert.deepEqual(
            result.targets.map((target) => target.wabaId),
            ['3'],
        );
        assert.deepEqual(
            p.graph.wabas[3].templates.map((t) => t.name),
            ['keep'],
        );
        assert.deepEqual(
            p.graph.wabas[4].templates.map((t) => t.name),
            ['keep', 'old'],
            'the other prod WABA is untouched',
        );
    });

    it('without --prune lists target-only templates as extra', async () => {
        const p = setup();
        const result = json(await p.cli(['deploy', '--from', 'dev', '--to', 'qa', '--json']));
        assert.deepEqual(
            result.targets[0].actions.map((action) => action.action),
            ['unchanged', 'extra'],
        );
    });
});

describe('wabadev import / deploy --csv', () => {
    const csv = [
        'Brand,Template name,Category,Meta Template,Language,Examples',
        'Acme,greet,Utility,Hello {{1}},en_US,Jane',
        'Acme,broken,Utility,Hi {{1}},en_US,',
    ].join('\n');

    it('import writes files and keeps buttons of existing files', async () => {
        const p = project();
        writeFileSync(path.join(p.cwd, 'sheet.csv'), csv);
        const directory = path.join(p.cwd, 'templates', 'greet');
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            path.join(directory, 'en_US.json'),
            JSON.stringify({
                name: 'greet',
                language: 'en_US',
                category: 'MARKETING',
                components: [
                    { type: 'BODY', text: 'Old' },
                    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }] },
                ],
            }),
        );
        const result = await p.cli(['import', '--csv', 'sheet.csv', '--json']);
        assert.equal(result.code, 1, 'row error makes the run fail');
        const report = json(result);
        assert.deepEqual(
            report.rowErrors.map((error) => error.row),
            [3],
        );
        const written = JSON.parse(readFileSync(path.join(directory, 'en_US.json'), 'utf8'));
        assert.equal(written.category, 'MARKETING', 'existing category is kept');
        assert.deepEqual(
            written.components.map((component) => component.type),
            ['BODY', 'BUTTONS'],
        );
        assert.equal(written.components[0].text, 'Hello {{1}}');
        assert.equal(existsSync(path.join(p.cwd, 'templates', 'broken')), false);
    });

    it('deploy --csv upserts directly and keeps the target buttons', async () => {
        const p = project({
            2: [
                {
                    ...bodyTemplate('greet', 'en_US', 'Old'),
                    components: [
                        { type: 'BODY', text: 'Old' },
                        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }] },
                    ],
                },
            ],
        });
        writeFileSync(path.join(p.cwd, 'sheet.csv'), csv.split('\n').slice(0, 2).join('\n'));
        const result = json(await p.cli(['deploy', '--csv', 'sheet.csv', '--to', 'qa', '--json']));
        assert.equal(result.ok, true);
        assert.equal(result.targets[0].actions[0].action, 'update');
        const live = p.graph.wabas[2].templates[0];
        assert.deepEqual(
            live.components.map((component) => component.type),
            ['BODY', 'BUTTONS'],
        );
    });
});

describe('wabadev check and usage', () => {
    it('reports a missing token variable and a rejected token per WABA, read-only', async () => {
        const p = project();
        const result = await p.cli(['check', '--json'], { T_DEV: 'tok-dev', T_QA: 'wrong' });
        assert.equal(result.code, 1);
        const report = json(result);
        assert.deepEqual(
            report.entries.map((entry) => [entry.wabaId, entry.ok]),
            [
                ['1', true],
                ['2', false],
                ['3', false],
                ['4', false],
            ],
        );
        assert.match(report.entries[1].error, /#190/);
        assert.match(report.entries[2].error, /T_PROD/);
        assert.equal(p.writes().length, 0);
        assert.doesNotMatch(result.out, /tok-dev|wrong/);
    });

    it('warns when Meta has disabled a WABA, but not for the payment error every test WABA has', async () => {
        const p = project();
        const paymentError = {
            error_code: 141_006,
            error_description: 'There is an error with the payment method.',
        };
        // Shapes as Meta returned them live (2026-11-22) for a disabled and a working test WABA.
        p.graph.wabas[1].account = {
            account_review_status: 'REJECTED',
            health_status: {
                can_send_message: 'BLOCKED',
                entities: [
                    {
                        entity_type: 'WABA',
                        id: '1',
                        errors: [
                            paymentError,
                            { error_code: 141_014, error_description: 'The WABA is banned.' },
                        ],
                    },
                ],
            },
        };
        p.graph.wabas[2].account = {
            account_review_status: 'APPROVED',
            health_status: {
                can_send_message: 'BLOCKED',
                entities: [{ entity_type: 'WABA', id: '2', errors: [paymentError] }],
            },
        };
        const environment = { T_DEV: 'tok-dev', T_QA: 'tok-qa', T_PROD: 'tok-prod' };
        const report = json(await p.cli(['check', '--json'], environment));
        assert.equal(report.ok, true);
        assert.deepEqual(
            report.entries.map((entry) => entry.warnings.map((warning) => warning.code)),
            [['WABA_DISABLED'], [], [], []],
        );
        const text = await p.cli(['check', '--stage', 'dev'], environment);
        assert.equal(text.code, 0);
        assert.match(text.out, /OK\s+dev\s+WABA 1[^\n]*\n\s+WARN\s+Meta has disabled this WABA/);
        assert.match(
            p.graph.calls.find((call) => call.path === '/v23.0/1').query.fields,
            /account_review_status,health_status/,
        );
    });

    it('reads tokens from .env in the project', async () => {
        const p = project();
        writeFileSync(path.join(p.cwd, '.env'), 'T_DEV=tok-dev\n');
        const result = await p.cli(['check', '--stage', 'dev'], {});
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /OK\s+dev\s+WABA 1/);
    });

    it('rejects unknown commands, options and missing values with exit code 2', async () => {
        const p = project();
        assert.equal((await p.cli(['publish'])).code, 2);
        assert.equal((await p.cli(['retrieve'])).code, 2);
        assert.equal((await p.cli(['check', '--to', 'qa'])).code, 2);
        assert.equal((await p.cli(['deploy', '--to', 'nope'])).code, 2);
        assert.equal(
            (await p.cli(['deploy', '--to', 'qa', '--from', 'dev', '--csv', 'a.csv'])).code,
            2,
        );
        assert.equal((await p.cli(['--bogus'])).code, 2);
        assert.equal((await p.cli(['--help'])).code, 0);
        assert.match((await p.cli(['--version'])).out, /^\d+\.\d+\.\d+$/);
    });

    it('puts the error code into --json errors', async () => {
        const p = project();
        const result = await p.cli(['discover', '--token-env', 'NOT_SET', '--json'], {});
        assert.equal(result.code, 2);
        const report = json(result);
        assert.equal(report.ok, false);
        assert.match(report.error, /NOT_SET/);
        assert.equal(report.code, undefined);
        const invalid = await p.cli(['discover', '--token-env', 'T_DEV', '--json'], {
            T_DEV: 'tok-none',
        });
        assert.equal(json(invalid).code, 'TOKEN_INVALID', invalid.out);
    });
});
