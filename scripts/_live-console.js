/* _live-console.js — attach to the REAL packaged app and dump renderer console. */
'use strict';
const { app } = require('electron');
// This script runs INSIDE the packaged app via ELECTRON_RUN_AS_NODE? No —
// instead we patch main to forward console. Simplest: run the app's own main
// but add a console-message forwarder. We require the real main after wiring.
process.env.FORGE_DEBUG_CONSOLE = '1';
const path = require('path');
require(path.join(__dirname, '..', 'src', 'main.js'));
