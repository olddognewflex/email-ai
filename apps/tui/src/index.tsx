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
Keys (list):    j/k or arrows move · enter open · a approve · r reject
                x block sender · s sync all accounts · q quit
                R sender rules · G rule suggestions
Keys (detail):  a approve · r reject (pick corrected category, esc cancels)
                x block sender · n next pending · o open web view
                j/k scroll body · b or esc back to list · q quit
Keys (rules):   space enable/disable · d delete (y/n) · b back
Keys (suggest): c create the family's rules (y/n) · b back
Block (x):      pick this address or this domain, then trash (default,
                category delete) or classify with a category; shows how
                much stored mail matches before you confirm. Rules only
                pre-classify for now: trash rules will move mail to Trash
                once mailbox writes are enabled.
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
