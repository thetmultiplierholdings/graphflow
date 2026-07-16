"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useLedgerStore } from "@/lib/stores/ledger-store"

const PLACEHOLDER = "e.g. Acme Ltd — UK Tax FY 2026/27"

interface NewEngagementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Creates the isolation boundary: one client, one year of work, one ledger.
export function NewEngagementDialog({ open, onOpenChange }: NewEngagementDialogProps) {
  const router = useRouter()
  const createEngagement = useLedgerStore((s) => s.createEngagement)

  const [label, setLabel] = useState("")
  const [creating, setCreating] = useState(false)

  const canCreate = label.trim().length > 0 && !creating

  const close = () => {
    setLabel("")
    onOpenChange(false)
  }

  const create = async () => {
    if (!canCreate) return
    const trimmed = label.trim()
    setCreating(true)
    try {
      const id = await createEngagement({ label: trimmed })
      toast.success(`Engagement "${trimmed}" created.`)
      close()
      router.push(`/engagements/${id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create the engagement.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Engagement</DialogTitle>
          <DialogDescription>
            An engagement is an isolated ledger — a client plus a year of work. Nothing is ever
            shared across engagements.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="new-engagement-label">Label</Label>
          <Input
            id="new-engagement-label"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={PLACEHOLDER}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create()
            }}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={() => void create()}>
            <PlusIcon className="size-4" />
            <span className="ml-1">{creating ? "Creating…" : "Create Engagement"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
