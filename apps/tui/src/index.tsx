#!/usr/bin/env node
import { render } from "ink";
import { App } from "./components/App.js";
import { API_BASE } from "./api.js";
const USAGE = `eai — keyboard-driven review of AI email classifications
Usage:
  eai                      open the review queue list
  eai <classificationId>   open the detail screen for one item
  eai --help               show this help
Environment:
  PORT   API port (default 3000, current target ${API_BASE})
  EAI_BLOCK_ON_UNSUBSCRIBE
         u also blocks the sender's address (default on; 0/false/no/off
         only opens the link)
Keys (list):    j/k or arrows move · enter open · a approve · r reject
                x block sender · z undo block · u unsubscribe + block
                s sync all accounts · q quit
                R sender rules · G rule suggestions · M mailbox actions
Keys (detail):  a approve · r reject (pick corrected category, esc cancels)
                x block sender · z undo block · u unsubscribe + block
                n next pending · o open web view
                j/k scroll body · b or esc back to list · q quit
Keys (rules):   space enable/disable · e edit · d delete (y/n) · b back
Keys (suggest): c create the family's rules (y/n) · b back
Keys (actions): j/k move · u undo a move to Trash (y/n) · f filter by status
                p preview apply (dry run only) · c reconcile (y/n)
                r refresh · b back
Block (x):      pick this address or this domain, then trash (default,
                category delete) or classify with a category; shows how
                much stored mail matches before you confirm. Rules only
                pre-classify unless mailbox writes are enabled; then the
                hourly job moves mail matching trash rules to Trash.
                Says so if an enabled rule already covers the sender.
Unsubscribe (u): opens the link; once it opened, blocks this ADDRESS
                (trash rule, never the domain) unless a rule already
                covers the sender. EAI_BLOCK_ON_UNSUBSCRIBE=0 turns this off.
Edit (e):       in R, edit the selected rule's pattern, match type,
                action, category, enabled and note; sends only what
                changed. Shows the match preview when pattern or match
                type changed, and a Trash warning with the saved rule's
                dry-run count when the edit makes it move mail. Only y
                saves (never Enter). Past classifications stay unchanged.
Undo (z):       y/n, then deletes the last rule this session created
                (by x or u).
Actions (M):    recent moves to Trash and restores, with the writes
                enabled/disabled state. The TUI never starts a live apply:
                p is always a dry run. Undo and reconcile need writes
                enabled (MAILBOX_WRITES_ENABLED=true on the API).
`;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  process.stderr.write(
    "eai is an interactive TUI — run it in a terminal.\n",
  );
  process.exit(1);
}
const initialId = args.find((arg) => !arg.startsWith("-"));

// Enter the alternate screen buffer so the TUI renders into a fixed,
// top-anchored viewport instead of the scrollback. Without this, a frame
// taller than the window scrolls the top (header) out of view permanently.
const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  process.stdout.write(LEAVE_ALT);
};
process.stdout.write(ENTER_ALT);
process.on("exit", restore);

const { waitUntilExit } = render(<App initialId={initialId} />);
waitUntilExit().then(restore, restore);
