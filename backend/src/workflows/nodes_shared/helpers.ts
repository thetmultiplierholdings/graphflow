// Helpers shared by the version-spanning nodes. Same contract as the nodes themselves: an edit
// here changes every node that uses it, under unchanged names — behavior changes force renames
// of the affected nodes.

export type Txn = { date: string; description: string; amount: string };

// Mock OCR core: lines shaped 'YYYY-MM-DD | DESCRIPTION | 123.45'. Amounts stay decimal STRINGS
// end to end (floats are banned in hashed payloads).
export function parseTransactionLines(text: string): Txn[] {
  const txns: Txn[] = [];
  for (const line of text.split('\n')) {
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length === 3 && parts[0].length === 10 && parts[0][4] === '-') {
      txns.push({ date: parts[0], description: parts[1], amount: parts[2] });
    }
  }
  return txns;
}
