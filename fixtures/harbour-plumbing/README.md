# Fixture client: Harbour Plumbing & Gas

**Entirely fictional.** No real people, customers or businesses. Phone numbers use the
ACMA ranges reserved for fiction, email domains end in `.example`, and the ABN, BSB and
account numbers are placeholders. Bank details are deliberately present so the Phase 2
redaction pass has something to strip.

## Raw inputs (what a real client folder would hold)

| Path | Evidence ID | What it is |
|---|---|---|
| `client.json` | — | Client profile (input to Prepare) |
| `transcript/intake-2026-10-01.vtt` | `T-0001`…`T-0045` | Intake interview, speaker labels and timestamps |
| `documents/01-invoice-INV-2041.pdf` | `D-01 p1` | Homeowner invoice |
| `documents/02-invoice-INV-2047.pdf` | `D-02 p1` | Agency invoice with work order number |
| `documents/03-invoice-INV-2052.pdf` | `D-03 p1` | Strata invoice, after-hours |
| `documents/04-email-invoice-INV-2041.eml` | `D-04` | Invoice email (voice sample) |
| `documents/05-email-reminder-INV-2032.eml` | `D-05` | Overdue reminder (voice sample) |
| `documents/06-email-work-order-WO-55812.eml` | `D-06` | Work order from a property manager |
| `documents/07-email-receipts-2026-09.eml` | `D-07` | Monthly note to the bookkeeper |
| `documents/08-email-dispute-INV-2039.eml` | `D-08` | Owner's reply to a disputed invoice |
| `documents/09-rates-and-timesheet.xlsx` | `D-09 s1`, `D-09 s2` | Price List and Timesheet sheets, with formulas |

Document IDs follow sorted filename order, which the `NN-` prefixes make explicit.

## Things planted for later phases

- **Contradiction:** the transcript says payment terms are 14 days (`T-0011`); every invoice says 7 days.
- **Tasks mentioned but not described:** supplier bill matching (`T-0030`), gas compliance certificates (`T-0036`), licence and insurance renewals (`T-0041`, `T-0042`).
- **Judgement that doesn't transcribe:** "I just know which days those are" (`T-0028`).
- **Exceptions:** "unless" and "except when" in `T-0012`, `T-0013`, `T-0039`.
- **Out of scope:** consent and small talk (`T-0001`–`T-0004`, `T-0043`, `T-0044`).

## `sample/`

Hand-written examples of every pipeline output, used to test the schemas. They are
**not** the Phase 3 golden task list, which is written separately by hand.
`sample/evidence.json` is the Ingest stage's output for the raw files above; a test
fails if they drift apart. Regenerate it with `npm run fixture:evidence`.
