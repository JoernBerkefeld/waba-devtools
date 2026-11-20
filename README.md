# WABA DevTools (`wabadev`)

Retrieve, import and deploy **WhatsApp Business message templates** across several WhatsApp
Business Accounts (WABAs) — for example one WABA per pipeline stage (dev → qa → prod).

- Keep templates as JSON files in git and deploy them to every WABA of a stage.
- Copy templates straight from one stage's WABA to the next.
- Bulk-upsert template texts from a Google Sheets (CSV) export.
- Create what is missing, update what changed, leave the rest alone — a second deploy sends nothing.

It talks to Meta's Graph API directly and needs no other tool.

## Install

```bash
npm install --save-dev waba-devtools
npx wabadev --help
```

Node.js `^22.22.2 || >=24.15.0`.

## Quick start

1. Create `.wabadevrc.json` in your project folder:

   ```json
   {
     "stages": {
       "dev": [{ "wabaId": "111111111111111", "tokenEnv": "WABA_TOKEN_NONPROD" }],
       "qa": [{ "wabaId": "222222222222222", "tokenEnv": "WABA_TOKEN_NONPROD" }],
       "prod": [
         { "wabaId": "333333333333333", "tokenEnv": "WABA_TOKEN_PROD" },
         { "wabaId": "444444444444444", "tokenEnv": "WABA_TOKEN_PROD" }
       ]
     }
   }
   ```

2. Put the tokens into a `.env` file next to it (and add `.env` to `.gitignore`):

   ```text
   WABA_TOKEN_NONPROD=EAAG...
   WABA_TOKEN_PROD=EAAG...
   ```

3. Check access, retrieve, preview, deploy:

   ```bash
   npx wabadev check
   npx wabadev retrieve --from dev
   npx wabadev deploy --to qa --dry-run
   npx wabadev deploy --to qa
   ```

## Configuration — `.wabadevrc.json`

| Key                         | Required | Meaning                                                                                                  |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `stages`                    | yes      | Stage name → list of WABAs. A deploy to a stage goes to **all** of its WABAs.                            |
| `stages.<stage>[].wabaId`   | yes      | The WhatsApp Business Account ID.                                                                        |
| `stages.<stage>[].tokenEnv` | yes      | Name of the environment variable that holds the access token for this WABA. Several WABAs may share one. |
| `graphVersion`              | no       | Graph API version, default `v23.0`.                                                                      |
| `templatesDir`              | no       | Folder for template files, default `templates`.                                                          |

The config never contains tokens.

## Access tokens

`wabadev` uses a **System User access token** from the Meta business portfolio that owns your
WABAs:

1. In Meta Business Suite go to **Business settings → Users → System users** and create a system
   user.
2. Assign it the WABAs (with permission to manage templates) and the Meta app the token is for.
3. Generate a token for that app with the **`whatsapp_business_management`** permission.

Where the token lives:

- **Locally:** a `.env` file in the project folder. `wabadev` loads it on start; variables that are
  already set in your shell win.
- **CI/CD:** a secret of your pipeline, exposed as the environment variable named in `tokenEnv`.
- Tokens are never written to files, reports or `--json` output.

Recommended: one system user (and token) for production and another for all other stages, so a
non-production pipeline cannot change production.

WABAs connected through a provider (for example Salesforce) are still owned by your portfolio, so
your own system user can be assigned to them. Run `wabadev check` to confirm.

## Commands

```text
wabadev check    [--stage <stage>] [--json]
wabadev retrieve --from <stage> [--waba <id>] [-m <name>…] [--json]
wabadev import   --csv <file> [--json]
wabadev deploy   --to <stage> [-m <name>…] [--dry-run] [--json]
wabadev deploy   --from <stage> [--waba <id>] --to <stage> [-m <name>…] [--dry-run] [--json]
wabadev deploy   --csv <file> --to <stage> [--dry-run] [--json]
wabadev deploy   --to <stage> [--from <stage>] --prune [--yes]
```

- **`check`** — read-only. Per WABA: is the token variable set, is the WABA reachable, can its
  templates be listed.
- **`retrieve`** — writes the templates of one WABA to `templates/<name>/<language>.json`. Only the
  fields that define a template are kept (name, language, category, parameter format,
  components); IDs and statuses are dropped. A stage with several WABAs needs `--waba <id>`.
- **`import`** — writes the rows of a CSV file into template files (see below).
- **`deploy`** — makes every WABA of `--to` match the source. The source is the templates folder
  (default), another stage's WABA (`--from`) or a CSV file (`--csv`).
- **`-m, --template <name>`** — only these templates (all their languages). Repeatable.
- **`--dry-run`** — shows what would happen, including each template's current status at Meta.
  Nothing is sent.

### What deploy does

Templates are matched by **name + language**:

| Situation in the target WABA                            | Action                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| Template missing                                        | **create** (with the source's category)                 |
| Same content                                            | **unchanged**                                           |
| Different content, status APPROVED, REJECTED or PAUSED  | **update** (components only)                            |
| Different content, any other status (e.g. PENDING)      | **blocked** — reported, not sent                        |
| Media header, authentication (OTP) or carousel template | **skipped** — not supported yet                         |
| Only in the target                                      | **extra** — reported; deleted only with `--prune --yes` |

- **Category** is used when a template is created, but never changed by an update. Meta does not
  allow category changes on approved templates and sometimes re-categorizes templates itself. A
  different category is shown as a note.
- Created and updated templates go through Meta's review again and show as `PENDING` until Meta
  decides. Run `deploy --dry-run` later to see their status.
- A failing template does not stop the run; the next one is processed and the report shows Meta's
  error.

### `--prune`

Deletes templates that exist only in the target. Safety rules:

- Only for full-set deploys — refused together with `-m` or `--csv`.
- Refused when the source is empty.
- Templates this tool cannot recreate (media header, authentication, carousel) are never deleted;
  they stay listed as `extra`.
- Without `--yes`, the deletes are listed but not run.

Meta may block the name of a deleted template for a while, so it cannot be created again right
away.

## CSV import (Google Sheets)

Export the sheet with **File → Download → Comma-separated values (.csv)**. Columns (header names
are matched case-insensitively; other columns such as `Brand` are ignored):

| Column          | Required                    | Content                                                          |
| --------------- | --------------------------- | ---------------------------------------------------------------- |
| `Template name` | yes                         | Template name, e.g. `order_shipped`                              |
| `Category`      | yes                         | `Utility` or `Marketing` (authentication is not supported yet)   |
| `Meta Template` | yes                         | Body text, with variables `{{1}}`, `{{2}}`, …                    |
| `Language`      | yes                         | Meta language code, e.g. `fr`, `it`, `en_US`                     |
| `Examples`      | when the text has variables | One example per variable, separated by `\|`, e.g. `Jane\|A-1234` |

- `wabadev import --csv sheet.csv` writes the rows into template files. For an existing file only
  the body is replaced; header, footer, buttons and category stay as they are.
- `wabadev deploy --csv sheet.csv --to qa` sends the rows directly. For templates that already
  exist in a WABA, only their body is replaced there too.
- Rows with problems (missing values, missing examples, duplicates, named variables) are listed
  with their row number; the other rows are still processed.

## Output and exit codes

`--json` prints the full report as JSON (for scripts and CI).

| Exit code | Meaning                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Everything succeeded.                                                                                                                                     |
| `1`       | Something failed: a Meta error, a blocked template, a CSV row error, or a target WABA that could not be reached (incl. its token variable not being set). |
| `2`       | Wrong usage or configuration (unknown stage, missing option, invalid config, missing token for the source WABA, …).                                       |

## Meta limits to know

- Every WABA reviews its templates on its own: the same template can be approved in one WABA and
  rejected or re-categorized in another.
- Meta limits how many templates can be created per WABA per hour, and how often approved
  templates can be edited. Deploying only what changed keeps you well below these limits.

## Not supported yet

- Templates with an image, video or document header.
- Authentication (OTP) and carousel templates.

## License

MIT © Jörn Berkefeld
