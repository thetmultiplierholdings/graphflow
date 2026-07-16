import { useId, type ReactNode } from "react"

/**
 * Hand-crafted static SVG of the tax_demo_workflow DAG (workflows/tax_demo_workflow.py).
 *
 *   documents ×N ─▶ OCR (engine) ─▶ Verify OCR extraction (HUMAN, memoised)
 *   ── all chains fan in ─▶ Append to master list (FOLD) ─▶ Calculator ─▶ Combined report
 *
 * Demo-only hero visual for the Workflow Catalogue — deliberately NOT a graph
 * library. Colours come exclusively from the semantic CSS custom properties in
 * globals.css so light and dark mode both render correctly.
 */

const FONT_CODE = "var(--font-code)"

/* ------------------------------------------------------------------ glyphs */

function CpuGlyph({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      stroke={stroke}
      strokeWidth={1.4}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={2.5} y={2.5} width={11} height={11} rx={2} />
      <rect x={6.25} y={6.25} width={3.5} height={3.5} rx={0.75} />
      <path d="M5.5 0.5 V2.5 M10.5 0.5 V2.5 M5.5 13.5 V15.5 M10.5 13.5 V15.5 M0.5 5.5 H2.5 M0.5 10.5 H2.5 M13.5 5.5 H15.5 M13.5 10.5 H15.5" />
    </g>
  )
}

function PersonGlyph({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      stroke={stroke}
      strokeWidth={1.4}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={8} cy={4.75} r={2.75} />
      <path d="M2.8 14 c0 -3.1 2.3 -4.7 5.2 -4.7 s5.2 1.6 5.2 4.7" />
    </g>
  )
}

function MergeGlyph({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      stroke={stroke}
      strokeWidth={1.4}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 3 C7 3 7 8 12.5 8" />
      <path d="M1.5 13 C7 13 7 8 12.5 8" />
      <path d="M1.5 8 H8.5" />
      <path d="M11 5.75 L13.75 8 L11 10.25" />
    </g>
  )
}

function DocGlyph({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      stroke={stroke}
      strokeWidth={1.4}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 1.5 H9.5 L13 5 V13.5 A1 1 0 0 1 12 14.5 H4 A1 1 0 0 1 3 13.5 V2.5 A1 1 0 0 1 4 1.5 Z" />
      <path d="M9.5 1.5 V5 H13" />
      <path d="M5.5 8.5 H10.5 M5.5 11 H9" />
    </g>
  )
}

/* ---------------------------------------------------------------- fragments */

/** Rounded node card: glyph top-left, executor kicker top-right, 1-2 title lines. */
function NodeShell({
  x,
  y,
  w,
  h = 72,
  fill = "var(--card)",
  stroke = "var(--border)",
  kicker,
  kickerFill = "var(--muted-foreground)",
  line1,
  line2,
  sub,
  subFill = "var(--muted-foreground)",
  subMono = false,
  glyph,
}: {
  x: number
  y: number
  w: number
  h?: number
  fill?: string
  stroke?: string
  kicker?: string
  kickerFill?: string
  line1: string
  line2?: string
  sub?: string
  subFill?: string
  subMono?: boolean
  glyph: ReactNode
}) {
  const titleY = line2 || sub ? y + 46 : y + 50
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={fill} stroke={stroke} />
      {glyph}
      {kicker && (
        <text
          x={x + w - 12}
          y={y + 23}
          textAnchor="end"
          fontSize={8}
          fontWeight={600}
          letterSpacing="0.09em"
          fill={kickerFill}
        >
          {kicker}
        </text>
      )}
      <text x={x + 13} y={titleY} fontSize={11.5} fontWeight={600} fill="var(--foreground)">
        {line1}
      </text>
      {line2 && (
        <text x={x + 13} y={y + 60} fontSize={11.5} fontWeight={600} fill="var(--foreground)">
          {line2}
        </text>
      )}
      {sub && (
        <text
          x={x + 13}
          y={y + 60}
          fontSize={10}
          fill={subFill}
          fontFamily={subMono ? FONT_CODE : undefined}
        >
          {sub}
        </text>
      )}
    </g>
  )
}

/** Stacked-card treatment for the leaf document inputs, with an ×N badge. */
function DocumentStack({ x, y, lines }: { x: number; y: number; lines: [string, string] }) {
  const w = 104
  const h = 64
  return (
    <g>
      <rect x={x + 10} y={y + 10} width={w} height={h} rx={10} fill="var(--card)" stroke="var(--border)" opacity={0.45} />
      <rect x={x + 5} y={y + 5} width={w} height={h} rx={10} fill="var(--card)" stroke="var(--border)" opacity={0.75} />
      <rect x={x} y={y} width={w} height={h} rx={10} fill="var(--card)" stroke="var(--border)" />
      <DocGlyph x={x + 12} y={y + 10} stroke="var(--info-strong)" />
      <text x={x + 13} y={y + 42} fontSize={11.5} fontWeight={600} fill="var(--foreground)">
        {lines[0]}
      </text>
      <text x={x + 13} y={y + 56} fontSize={11.5} fontWeight={600} fill="var(--foreground)">
        {lines[1]}
      </text>
      <rect x={x + 80} y={y - 8} width={30} height={17} rx={8.5} fill="var(--info-muted)" stroke="var(--info)" />
      <text
        x={x + 95}
        y={y + 4}
        textAnchor="middle"
        fontSize={9.5}
        fontWeight={600}
        fill="var(--info-strong)"
      >
        ×N
      </text>
    </g>
  )
}

function Edge({ d, marker }: { d: string; marker: string }) {
  return (
    <path
      d={d}
      fill="none"
      stroke="var(--neutral)"
      strokeWidth={1.4}
      strokeLinecap="round"
      markerEnd={`url(#${marker})`}
    />
  )
}

/** Faint dashed duplicate edge — hints at the ×N chains fanning into the fold. */
function GhostEdge({ d }: { d: string }) {
  return (
    <path
      d={d}
      fill="none"
      stroke="var(--neutral)"
      strokeWidth={1.2}
      strokeDasharray="3 4"
      strokeLinecap="round"
      opacity={0.45}
    />
  )
}

/** Artifact-kind label set in tiny muted monospace along an edge. */
function KindLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={9}
      fill="var(--muted-foreground)"
      fontFamily={FONT_CODE}
      letterSpacing="0.02em"
    >
      {children}
    </text>
  )
}

function LaneHeader({ x, children }: { x: number; children: string }) {
  return (
    <text
      x={x}
      y={36}
      textAnchor="middle"
      fontSize={10}
      fontWeight={600}
      letterSpacing="0.1em"
      fill="var(--muted-foreground)"
    >
      {children}
    </text>
  )
}

/* --------------------------------------------------------------- the graph */

export function TaxDemoWorkflowGraph({
  ratePct,
  highlightCalculator = false,
}: {
  ratePct: string
  highlightCalculator?: boolean
}) {
  // Marker ids must be unique per instance; strip useId's punctuation so the
  // id survives the url(#…) reference.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const arrow = `${uid}-arrow`
  const titleId = `${uid}-title`

  return (
    <svg
      viewBox="0 0 1100 420"
      role="img"
      aria-labelledby={titleId}
      style={{ width: "100%", height: "auto", display: "block", fontFamily: "inherit" }}
    >
      <title id={titleId}>
        {`Tax demo workflow: brokerage statements and payment slips are OCR'd per document, each extraction is verified by a human once per engagement, all chains fold into a master transaction list, a calculator applies ${ratePct}, and a combined report is produced.`}
      </title>

      <defs>
        <marker
          id={arrow}
          viewBox="0 0 8 8"
          refX={7}
          refY={4}
          markerWidth={7}
          markerHeight={7}
          orient="auto"
        >
          <path d="M0.5 0.8 L7.2 4 L0.5 7.2 Z" fill="var(--neutral)" />
        </marker>
      </defs>

      {/* ---- lane headers ---- */}
      <LaneHeader x={82}>DOCUMENTS</LaneHeader>
      <LaneHeader x={256}>EXTRACT</LaneHeader>
      <LaneHeader x={454}>HUMAN REVIEW</LaneHeader>
      <LaneHeader x={656}>FOLD</LaneHeader>
      <LaneHeader x={836}>CALCULATE</LaneHeader>
      <LaneHeader x={1008}>DELIVERABLE</LaneHeader>
      <line x1={30} y1={50} x2={1070} y2={50} stroke="var(--border)" />

      {/* ---- edges (drawn under the nodes) ---- */}
      {/* documents ─▶ OCR */}
      <Edge d="M134 128 C150 150 166 150 182 128" marker={arrow} />
      <Edge d="M134 304 C150 282 166 282 182 304" marker={arrow} />
      <KindLabel x={158} y={167}>brokerage_statement</KindLabel>
      <KindLabel x={158} y={265}>payment_slip</KindLabel>

      {/* OCR ─▶ verify */}
      <Edge d="M330 128 C346 150 362 150 378 128" marker={arrow} />
      <Edge d="M330 304 C346 282 362 282 378 304" marker={arrow} />
      <KindLabel x={354} y={167}>ocr_txns</KindLabel>
      <KindLabel x={354} y={265}>ocr_txns</KindLabel>

      {/* verify ══▶ fold: every verified chain converges (fan-in) */}
      <Edge d="M530 116 C556 116 556 198 586 198" marker={arrow} />
      <Edge d="M530 316 C556 316 556 234 586 234" marker={arrow} />
      <GhostEdge d="M530 130 C556 130 556 210 586 210" />
      <GhostEdge d="M530 302 C556 302 556 222 586 222" />
      <KindLabel x={544} y={219}>verified_txns</KindLabel>
      <text
        x={544}
        y={232}
        textAnchor="middle"
        fontSize={8.5}
        fill="var(--muted-foreground)"
        opacity={0.85}
      >
        ×N chains
      </text>

      {/* fold ─▶ calculator ─▶ report */}
      <Edge d="M726 228 C742 250 758 250 774 228" marker={arrow} />
      <Edge d="M898 228 C914 250 930 250 946 228" marker={arrow} />
      <KindLabel x={750} y={267}>master_txn_list</KindLabel>
      <KindLabel x={922} y={267}>tax_calc</KindLabel>

      {/* ---- documents (leaf inputs, one stack per kind, fan out per file) ---- */}
      <DocumentStack x={30} y={84} lines={["Brokerage", "statements"]} />
      <DocumentStack x={30} y={284} lines={["Payment", "slips"]} />

      {/* ---- OCR engine nodes ---- */}
      <NodeShell
        x={182}
        y={80}
        w={148}
        kicker="ENGINE"
        line1="OCR brokerage"
        line2="statement"
        glyph={<CpuGlyph x={194} y={92} stroke="var(--primary)" />}
      />
      <NodeShell
        x={182}
        y={280}
        w={148}
        kicker="ENGINE"
        line1="OCR payment slip"
        glyph={<CpuGlyph x={194} y={292} stroke="var(--primary)" />}
      />

      {/* ---- the human review step: the product's soul. One question per
             distinct document, answered once, memoised forever. ---- */}
      <rect x={374} y={76} width={160} height={80} rx={13} fill="none" stroke="var(--warning)" opacity={0.4} />
      <rect x={374} y={276} width={160} height={80} rx={13} fill="none" stroke="var(--warning)" opacity={0.4} />
      <NodeShell
        x={378}
        y={80}
        w={152}
        fill="var(--warning-muted)"
        stroke="var(--warning)"
        kicker="HUMAN"
        kickerFill="var(--warning-strong)"
        line1="Verify OCR"
        line2="extraction"
        glyph={<PersonGlyph x={390} y={92} stroke="var(--warning-strong)" />}
      />
      <NodeShell
        x={378}
        y={280}
        w={152}
        fill="var(--warning-muted)"
        stroke="var(--warning)"
        kicker="HUMAN"
        kickerFill="var(--warning-strong)"
        line1="Verify OCR"
        line2="extraction"
        glyph={<PersonGlyph x={390} y={292} stroke="var(--warning-strong)" />}
      />
      {/* shared caption tying both review nodes together */}
      <line x1={454} y1={156} x2={454} y2={176} stroke="var(--warning)" strokeWidth={1} strokeDasharray="1.5 3.5" opacity={0.7} />
      <line x1={454} y1={212} x2={454} y2={276} stroke="var(--warning)" strokeWidth={1} strokeDasharray="1.5 3.5" opacity={0.7} />
      <text x={454} y={188} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--warning-strong)">
        Asked once per engagement,
      </text>
      <text x={454} y={202} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--warning-strong)">
        answered forever
      </text>

      {/* ---- the fold: N verified batches become one master list ---- */}
      <NodeShell
        x={586}
        y={180}
        w={140}
        kicker="FOLD · ENGINE"
        line1="Append to master"
        line2="transaction list"
        glyph={<MergeGlyph x={598} y={192} stroke="var(--primary)" />}
      />

      {/* ---- calculator (rate is the only v1 → v2 change) ---- */}
      {highlightCalculator && (
        <>
          <rect x={769} y={175} width={134} height={82} rx={14} fill="none" stroke="var(--info)" strokeWidth={1.5} />
          <rect x={817} y={158} width={86} height={18} rx={9} fill="var(--info-muted)" stroke="var(--info)" />
          <text x={860} y={170.5} textAnchor="middle" fontSize={9} fontWeight={600} fill="var(--info-strong)">
            Changed in v2
          </text>
        </>
      )}
      <NodeShell
        x={774}
        y={180}
        w={124}
        kicker="ENGINE"
        line1="Calculator"
        sub={`sum × ${ratePct}`}
        subFill={highlightCalculator ? "var(--info-strong)" : "var(--muted-foreground)"}
        subMono
        glyph={<CpuGlyph x={786} y={192} stroke="var(--primary)" />}
      />

      {/* ---- the deliverable ---- */}
      <NodeShell
        x={946}
        y={180}
        w={124}
        fill="var(--success-muted)"
        stroke="var(--success)"
        kicker="ENGINE"
        kickerFill="var(--success-strong)"
        line1="Combined report"
        sub="final deliverable"
        subFill="var(--success-strong)"
        glyph={<DocGlyph x={958} y={192} stroke="var(--success-strong)" />}
      />
      <KindLabel x={1008} y={267}>final_report</KindLabel>

      {/* ---- footer ---- */}
      <text x={30} y={402} fontSize={10} fill="var(--muted-foreground)">
        Attach any number of source documents → one combined report. Every node result is memoised
        per engagement — re-runs only pay for what changed.
      </text>
    </svg>
  )
}
