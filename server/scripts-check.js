'use strict';
const fs = require('fs'),
  path = require('path'),
  { execFileSync } = require('child_process');
function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) walk(name);
    else if (name.endsWith('.js'))
      execFileSync(process.execPath, ['--check', name], { stdio: 'inherit' });
  }
}
walk(path.join(__dirname, 'src'));
walk(path.join(__dirname, 'test'));
execFileSync(process.execPath, ['--check', path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
});
execFileSync(process.execPath, ['--check', path.join(__dirname, '../public/script.js')], {
  stdio: 'inherit',
});
console.log('JavaScript syntax checks passed.');
