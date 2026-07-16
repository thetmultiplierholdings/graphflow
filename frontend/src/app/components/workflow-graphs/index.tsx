import type { ReactElement } from "react"
import { TaxDemoWorkflowGraph } from "./tax-demo-workflow-graph"

/**
 * Registry mapping workflow_id → static DAG diagram. The catalogue page looks
 * ids up here and falls back to a "no diagram available" empty state for
 * workflows without a hand-crafted graph.
 */
export const WORKFLOW_GRAPHS: Record<string, () => ReactElement> = {
  tax_demo_workflow: () => <TaxDemoWorkflowGraph ratePct="25%" />,
  tax_demo_workflow_v2: () => <TaxDemoWorkflowGraph ratePct="24%" highlightCalculator />,
}

export { TaxDemoWorkflowGraph }
