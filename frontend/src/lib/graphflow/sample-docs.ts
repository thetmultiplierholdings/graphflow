// Mock "PDF" documents (plain text) — mirrors sample_docs/ in the graphflow repo.
// The attach dialog offers these for upload; identical bytes re-supplied under
// the same kind land on the existing artifact row (the revive path).

export interface SampleDoc {
  filename: string
  kind: "brokerage_statement" | "payment_slip"
  content: string
}

export const SAMPLE_DOCS: SampleDoc[] = [
  {
    filename: "morgan_stanley.txt",
    kind: "brokerage_statement",
    content: `MORGAN STANLEY BROKERAGE STATEMENT - JAN 2026
ACCOUNT 4471-8829
--- TRANSACTIONS ---
2026-01-05 | DIVIDEND AAPL | 120.50
2026-01-12 | DIVIDEND MSFT | 88.20
2026-01-28 | BOND INTEREST | 45.00
`,
  },
  {
    filename: "goldman_sachs.txt",
    kind: "brokerage_statement",
    content: `GOLDMAN SACHS BROKERAGE STATEMENT - JAN 2026
ACCOUNT GS-99120
--- TRANSACTIONS ---
2026-01-09 | DIVIDEND VWRL | 310.00
2026-01-22 | DIVIDEND SPY | 75.25
`,
  },
  {
    filename: "fidelity.txt",
    kind: "brokerage_statement",
    content: `FIDELITY BROKERAGE STATEMENT - JAN 2026
ACCOUNT F-55210
--- TRANSACTIONS ---
2026-01-03 | DIVIDEND VTI | 92.10
2026-01-17 | MONEY MARKET INTEREST | 14.90
2026-01-30 | DIVIDEND QQQ | 200.00
`,
  },
  {
    filename: "extra_ubs.txt",
    kind: "brokerage_statement",
    content: `UBS BROKERAGE STATEMENT - APR 2026
ACCOUNT UBS-70331
--- TRANSACTIONS ---
2026-04-08 | DIVIDEND NESN | 66.60
2026-04-19 | DIVIDEND NOVN | 13.40
`,
  },
  {
    filename: "payslip_jan.txt",
    kind: "payment_slip",
    content: `PAYMENT SLIP - JANUARY 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-01-31 | NET SALARY | 5200.00
2026-01-31 | PERFORMANCE BONUS | 400.00
`,
  },
  {
    filename: "payslip_feb.txt",
    kind: "payment_slip",
    content: `PAYMENT SLIP - FEBRUARY 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-02-28 | NET SALARY | 5200.00
`,
  },
  {
    filename: "payslip_mar.txt",
    kind: "payment_slip",
    content: `PAYMENT SLIP - MARCH 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-03-31 | NET SALARY | 5200.00
2026-03-31 | OVERTIME | 150.00
`,
  },
  {
    filename: "extra_payslip_apr.txt",
    kind: "payment_slip",
    content: `PAYMENT SLIP - APRIL 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-04-30 | NET SALARY | 5200.00
2026-04-30 | MEAL ALLOWANCE | 75.00
`,
  },
  {
    filename: "bh_schwab.txt",
    kind: "brokerage_statement",
    content: `CHARLES SCHWAB BROKERAGE STATEMENT - FEB 2026
ACCOUNT SW-30419
--- TRANSACTIONS ---
2026-02-06 | DIVIDEND VOO | 154.75
2026-02-20 | DIVIDEND SCHD | 98.40
`,
  },
  {
    filename: "bh_payslip_feb.txt",
    kind: "payment_slip",
    content: `PAYMENT SLIP - FEBRUARY 2026
EMPLOYER: BLUE HARBOUR LLP
--- PAYMENTS ---
2026-02-27 | NET SALARY | 6100.00
2026-02-27 | CAR ALLOWANCE | 350.00
`,
  },
]

export function sampleDoc(filename: string): SampleDoc {
  const doc = SAMPLE_DOCS.find((d) => d.filename === filename)
  if (!doc) throw new Error(`unknown sample doc ${filename}`)
  return doc
}
