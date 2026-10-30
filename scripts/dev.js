#!/usr/bin/env node
'use strict';

// Launcher for npm run dev
// Strips ELECTRON_RUN_AS_NODE so Electron starts as an interactive desktop GUI application
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('node:child_process');
const electron = require('electron');

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
);

const child = spawn(electron, ['.', '--dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
  env: cleanEnv,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

