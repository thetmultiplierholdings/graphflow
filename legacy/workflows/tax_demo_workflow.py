"""tax_demo_workflow — the first workflow.

Two folding flows over "PDF" documents (mocked as .txt):

  brokerage_statement --> mock OCR --> mock HITL verify --+
  payment_slip        --> mock OCR --> mock HITL verify --+--> FOLD into
                                                              master_txn_list
                                                              --> calculator (sum * 25%)
                                                              --> single combined report
                                                                  (all pages + summation page)

The FOLD is append_to_master: it takes the LIST of per-document verified
batches as one input. Its memo key therefore depends on the whole set —
attach a 4th statement and only the new chain plus the fold/calc/report
re-execute; the 3 old chains (including their human answers) memo-hit.
"""

from __future__ import annotations

import asyncio
import re
from decimal import ROUND_HALF_UP, Decimal

from engine import Ctx, HumanTask, Kind, human_node, node, workflow_def

TAX_RATE = "0.25"

VERIFIED_TXNS_SCHEMA = ["approved", "transactions"]

_DECIMAL_RE = re.compile(r"^-?(\d+(\.\d*)?|\.\d+)$")


def validate_verified_txns(result: dict) -> None:
    """Answer contract for verify_txns. Accepted answers are memoized forever
    (one answer per question per engagement), so malformed rows must be
    rejected at submission — never filed into the insert-only ledger."""
    if not isinstance(result.get("approved"), bool):
        raise ValueError("'approved' must be a boolean")
    txns = result.get("transactions")
    if not isinstance(txns, list):
        raise ValueError("'transactions' must be a list")
    for i, t in enumerate(txns, start=1):
        if not isinstance(t, dict):
            raise ValueError(f"transaction {i}: must be an object")
        if not isinstance(t.get("date"), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", t["date"]):
            raise ValueError(f"transaction {i}: date must be YYYY-MM-DD")
        if not isinstance(t.get("description"), str) or not t["description"].strip():
            raise ValueError(f"transaction {i}: description is required")
        if not isinstance(t.get("amount"), str) or not _DECIMAL_RE.fullmatch(t["amount"]):
            raise ValueError(
                f"transaction {i}: amount {t.get('amount')!r} must be a plain decimal string like '120.50'"
            )


# ---------- shared helper (folded into code hashes via hash_with) ----------

def parse_transaction_lines(text: str) -> list[dict]:
    """Mock OCR core: lines shaped 'YYYY-MM-DD | DESCRIPTION | 123.45'.
    Amounts stay decimal STRINGS end to end (floats are banned in payloads)."""
    txns = []
    for line in text.splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) == 3 and len(parts[0]) == 10 and parts[0][4] == "-":
            txns.append({"date": parts[0], "description": parts[1], "amount": parts[2]})
    return txns


# ---------- nodes ----------

@node(output_kind="ocr_txns", hash_with=[parse_transaction_lines],
      display_name="OCR brokerage statement (mock)")
def ocr_brokerage_statement(statement):
    return {"doc_kind": "brokerage_statement",
            "transactions": parse_transaction_lines(statement.text())}


@node(output_kind="ocr_txns", hash_with=[parse_transaction_lines],
      display_name="OCR payment slip (mock)")
def ocr_payment_slip(slip):
    return {"doc_kind": "payment_slip",
            "transactions": parse_transaction_lines(slip.text())}


@human_node(output_kind="verified_txns", title="Verify OCR extraction",
            hash_with=[VERIFIED_TXNS_SCHEMA],
            result_validator=validate_verified_txns)
def verify_txns(ocr):
    return HumanTask(
        instructions=(
            "Compare the extracted transactions against the source document. "
            "Correct any misread digits, then approve."
        ),
        payload={"ocr": ocr},
        result_required_keys=VERIFIED_TXNS_SCHEMA,
    )


@node(output_kind="master_txn_list", display_name="Append to master transaction list (FOLD)")
def append_to_master(batches):
    """THE FOLD: N per-document verified batches -> one master list."""
    txns = []
    for batch in batches:
        txns.extend(batch.json()["transactions"])
    txns.sort(key=lambda t: (t["date"], t["description"], t["amount"]))
    return {"transactions": txns, "count": len(txns)}


@node(output_kind="tax_calc", display_name="Calculator (mock): sum * 25%",
      hash_with=[TAX_RATE])
def calculate_tax(master):
    total = sum((Decimal(t["amount"]) for t in master.json()["transactions"]), Decimal("0"))
    tax = (total * Decimal(TAX_RATE)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {
        "total": str(total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
        "tax_rate": TAX_RATE,
        "tax_due": str(tax),
    }


@node(output_kind="final_report", display_name="Combine documents into single report")
def build_report(statements, slips, master, calc):
    """One 'PDF' (a text file): every source document as a page, then a final
    page with the summation calculations. Page headers come from the first
    line of each document's bytes — never from mutable labels."""
    pages = []
    docs = list(statements) + list(slips)
    docs.sort(key=lambda d: d.text().splitlines()[0])
    for i, doc in enumerate(docs, start=1):
        text = doc.text().rstrip()
        title = text.splitlines()[0]
        pages.append(f"--- PAGE {i}: {title} ---\n{text}")

    m = master.json()
    c = calc.json()
    lines = [f"--- FINAL PAGE: SUMMATION ({m['count']} transactions) ---"]
    for t in m["transactions"]:
        lines.append(f"  {t['date']}  {t['description']:<28} {t['amount']:>12}")
    lines.append(f"  {'-' * 54}")
    lines.append(f"  {'TOTAL':<40} {c['total']:>12}")
    lines.append(f"  {'TAX RATE':<40} {c['tax_rate']:>12}")
    lines.append(f"  {'TAX DUE (total * 25%)':<40} {c['tax_due']:>12}")
    pages.append("\n".join(lines))

    header = "=" * 64 + "\n COMBINED TAX REPORT (graphflow demo)\n" + "=" * 64
    return header + "\n\n" + "\n\n".join(pages) + "\n"


# ---------- the workflow: plain code IS the DAG ----------

@workflow_def(
    id="tax_demo_workflow",
    display_name="Tax demo workflow",
    kinds=[
        Kind("brokerage_statement", display="Brokerage statement (PDF)"),
        Kind("payment_slip", display="Payment slip (PDF)"),
        Kind("ocr_txns"),
        Kind("verified_txns"),
        Kind("master_txn_list"),
        Kind("tax_calc"),
        Kind("final_report"),
    ],
)
async def run(ctx: Ctx) -> None:
    statements = ctx.attached("brokerage_statement")
    slips = ctx.attached("payment_slip")

    async def brokerage_chain(doc):
        ocr = await ctx.node(ocr_brokerage_statement, doc)
        return await ctx.node(verify_txns, ocr)          # human step, memoized

    async def slip_chain(doc):
        ocr = await ctx.node(ocr_payment_slip, doc)
        return await ctx.node(verify_txns, ocr)          # human step, memoized

    # Parallel chains: reviewer waits overlap; Temporal keeps gather deterministic.
    batches = list(await asyncio.gather(
        *(brokerage_chain(s) for s in statements),
        *(slip_chain(p) for p in slips),
    ))

    master = await ctx.node(append_to_master, batches)   # THE FOLD
    calc = await ctx.node(calculate_tax, master)
    await ctx.node(build_report, statements, slips, master, calc)
