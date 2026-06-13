#!/usr/bin/env node
import { render } from "ink";
import { App } from "./components/App.js";
import { API_BASE } from "./api.js";
const USAGE = `email-review — keyboard-driven review of AI email classifications
Usage:
  email-review                      open the review queue list
  email-review <classificationId>   open the detail screen for one item
  email-review --help               show this help
Environment:
  PORT   API port (default 3000, current target ${API_BASE})
Keys (list):    j/k or arrows move · enter open · a approve · r reject · q quit
Keys (detail):  a approve · r reject (pick corrected category, esc cancels)
                n next pending · o open web view · j/k scroll body
                b or esc back to list · q quit
`;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  process.stderr.write(
    "email-review is an interactive TUI — run it in a terminal.\n",
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
