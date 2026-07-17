// The full graphflow story, in a real browser against the real stack: the
// Fastify API over SQLite + Temporal Cloud (embedded worker), starting from an EMPTY
// database (the config clears leftover scratch state before the servers boot).
//
// Serial by design: each step continues the previous one's server state
// (engagement -> workspace -> documents -> run -> review -> report ->
// memoised re-run). A failure in one step makes the rest meaningless, so
// they are skipped.

import { test, expect } from "@playwright/test"
import {
  deleteScratchState,
  scratchDbExists,
  terminateScratchTemporalWorkflows,
} from "./scratch-cleanup"

const ENGAGEMENT_LABEL = "E2E Test Ltd — FY 2026/27"
const WORKSPACE_LABEL = "E2E January"

test.describe.configure({ mode: "serial" })

test.describe("full graphflow story", () => {
  let engagementPath = ""
  let workspacePath = ""

  test.afterAll(async () => {
    // Terminate the scratch instance's Temporal workflows FIRST (needs the
    // db to read the instance prefix), then delete db + payload store.
    // The webServer processes are still alive here (Playwright stops them
    // after teardown) — connections are per-request so deletion normally
    // succeeds anyway; on Windows a transient lock gets a few retries and
    // is otherwise left best-effort (global-setup clears leftovers next run).
    terminateScratchTemporalWorkflows()
    for (let attempt = 0; attempt < 3; attempt++) {
      deleteScratchState()
      if (!scratchDbExists()) break
      await new Promise((r) => setTimeout(r, 2000))
    }
  })

  test("1. create an engagement", async ({ page }) => {
    await page.goto("/engagements")
    await page.getByRole("button", { name: "New Engagement" }).first().click()
    await page.getByLabel("Label").fill(ENGAGEMENT_LABEL)
    await page.getByRole("button", { name: "Create Engagement" }).click()

    await expect(page).toHaveURL(/\/engagements\/\d+$/)
    await expect(page.getByRole("heading", { name: ENGAGEMENT_LABEL })).toBeVisible()
    engagementPath = new URL(page.url()).pathname
  })

  test("2. create a workspace", async ({ page }) => {
    await page.goto(engagementPath)
    await page.getByRole("button", { name: "New Workspace" }).first().click()
    // Workflow defaults to the only non-superseded file once the catalog loads.
    await page.getByLabel("Label").fill(WORKSPACE_LABEL)
    await page.getByRole("button", { name: "Create Workspace" }).click()

    await expect(page).toHaveURL(/\/workspaces\/\d+$/)
    await expect(page.getByRole("heading", { name: WORKSPACE_LABEL })).toBeVisible()
    workspacePath = new URL(page.url()).pathname
  })

  test("3. attach sample documents", async ({ page }) => {
    await page.goto(workspacePath)
    await page.getByRole("button", { name: "Attach" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("tab", { name: "Sample Documents" })).toBeVisible()
    await dialog
      .locator("label", { hasText: "morgan_stanley.txt" })
      .getByRole("checkbox")
      .check()
    await dialog
      .locator("label", { hasText: "payslip_jan.txt" })
      .getByRole("checkbox")
      .check()
    await dialog.getByRole("button", { name: "Attach 2" }).click()
    await expect(dialog).toBeHidden()

    // Both rows land in the Documents card (labels = filename minus .txt).
    await expect(page.getByText("morgan_stanley")).toBeVisible()
    await expect(page.getByText("payslip_jan")).toBeVisible()
  })

  test("4. run the workflow until it waits on reviewers", async ({ page }) => {
    await page.goto(workspacePath)
    await page.getByRole("button", { name: "Run", exact: true }).click()

    // Status flips to Running (badge in the header and in the run panel).
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })

    // The two OCR chains execute over real Temporal, then both verify steps
    // open human tasks: the event feed reports the waits and the info box
    // counts both reviewer answers.
    await expect(page.getByText(/waiting on a reviewer/).first()).toBeVisible({
      timeout: 180_000,
    })
    await expect(page.getByText(/Waiting on 2 reviewer answers/)).toBeVisible({
      timeout: 60_000,
    })

    // Sidebar Inbox badge (polled ~5s) shows the 2 open tasks. Match the
    // badge text within the link — accessible-name concatenation of the
    // label and the badge is browser-dependent.
    const inboxLink = page.getByRole("link", { name: /Inbox/ })
    await expect(inboxLink.getByText("2", { exact: true })).toBeVisible({
      timeout: 30_000,
    })
  })

  test("5. review both tasks from the inbox", async ({ page }) => {
    await page.goto("/inbox")
    const reviewButtons = page.getByRole("button", { name: "Review", exact: true })
    await expect(reviewButtons).toHaveCount(2, { timeout: 60_000 })

    // First task: the dialog shows the source document beside the editable
    // extraction rows; Approve & Submit files the answer.
    await reviewButtons.first().click()
    const dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Source Document" })
    ).toBeVisible()
    await expect(dialog.locator("pre")).toBeVisible() // the source document text
    await expect(dialog.getByLabel("Row 1 date")).toBeVisible() // editable rows
    await dialog.getByRole("button", { name: "Approve & Submit" }).click()
    await expect(page.getByText(/Answer filed to the ledger/).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(dialog).toBeHidden()

    // Second task: Auto-Approve the extraction unchanged.
    await expect(reviewButtons).toHaveCount(1, { timeout: 60_000 })
    await reviewButtons.first().click()
    await dialog.getByRole("button", { name: "Auto-Approve" }).click()
    await expect(page.getByText(/Answer filed to the ledger/).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(dialog).toBeHidden()
  })

  test("6. run completes and produces the combined report", async ({ page }) => {
    await page.goto(workspacePath)

    // The answered reviews resume the run; fold -> calculator -> report
    // execute and the derived status lands on Completed (the page polls ~3s).
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({
      timeout: 180_000,
    })

    // Results contain a final_report row; open it in the preview sheet.
    const reportRow = page.getByText(/final_report_/).first()
    await expect(reportRow).toBeVisible({ timeout: 60_000 })
    await reportRow.click()

    const sheet = page.getByRole("dialog")
    await expect(sheet.locator("pre")).toContainText("COMBINED TAX REPORT", {
      timeout: 30_000,
    })
    await expect(sheet.locator("pre")).toContainText("TOTAL")
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()
  })

  test("7. re-run memo-hits everything (0 executed)", async ({ page }) => {
    await page.goto(workspacePath)
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible()
    await page.getByRole("button", { name: "Run", exact: true }).click()

    // Same snapshot, same code: every node memo-hits and the run finishes
    // quickly. The run panel summary reports 0 executed + N memo hits.
    // (exact: the event feed's "Run finished: 0 executed, ..." also matches
    // the substring.)
    await expect(page.getByText("0 executed", { exact: true })).toBeVisible({
      timeout: 120_000,
    })
    await expect(page.getByText(/[1-9]\d* memo hits/).first()).toBeVisible()
  })

  test("8. catalog shows both workflow versions with badges", async ({ page }) => {
    await page.goto("/catalog")
    // The catalogue shows one version at a time behind a selector; the current
    // (non-superseded) version is selected by default.
    await expect(page.getByText("Tax demo workflow v2", { exact: true })).toBeVisible()
    await expect(page.getByText("Current version")).toBeVisible()
    // Switch to the superseded original and check its badge.
    await page.getByLabel("Select a workflow").click()
    await page.getByRole("option", { name: "Tax demo workflow (superseded)" }).click()
    await expect(page.getByText("Tax demo workflow", { exact: true })).toBeVisible()
    await expect(page.getByText(/Superseded by tax_demo_workflow_v2/)).toBeVisible()
  })
})
