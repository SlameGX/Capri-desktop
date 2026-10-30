const { spawn } = require('child_process');

console.log('Parent running');
const child = spawn('cmd.exe', [
  '/c', 'start', '""', 'powershell.exe',
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', 'C:\\Users\\Elxan\\Documents\\Projeler\\capri-desktop\\survive_test.ps1'
], {
  detached: true,
  stdio: 'ignore'
});
child.unref();

console.log('Parent exiting immediately');
process.exit(0);

