const {execFile} = require('node:child_process');
const {existsSync} = require('node:fs');
const path = require('node:path');
const {promisify} = require('node:util');
const {GitServiceError} = require('./github-auth');

const run = promisify(execFile);
const title = 'TurboWarp Plus Desktop – GitHub';

const macDialog = `
use scripting additions
on run argv
  set dialogResult to display dialog (item 1 of argv) default answer "" buttons {"Cancel", "Connect"} ¬
    default button "Connect" cancel button "Cancel" with title "TurboWarp Plus Desktop – GitHub" with hidden answer
  return text returned of dialogResult
end run
`;

function windowsDialog (message) {
  return `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '${title}'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(500, 158)

$label = New-Object System.Windows.Forms.Label
$label.Text = '${message.replace(/'/gu, "''")}'
$label.SetBounds(12, 12, 476, 54)
$label.AutoEllipsis = $true
$label.UseMnemonic = $false
$form.Controls.Add($label)

$entry = New-Object System.Windows.Forms.TextBox
$entry.UseSystemPasswordChar = $true
$entry.MaxLength = 1035
$entry.SetBounds(12, 73, 476, 23)
$form.Controls.Add($entry)

$connect = New-Object System.Windows.Forms.Button
$connect.Text = 'Connect'
$connect.DialogResult = 'OK'
$connect.SetBounds(322, 117, 80, 27)
$form.Controls.Add($connect)
$form.AcceptButton = $connect

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.DialogResult = 'Cancel'
$cancel.SetBounds(408, 117, 80, 27)
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

try {
  if ($form.ShowDialog() -ne 'OK') { exit 2 }
  [Console]::Out.Write($entry.Text)
} finally {
  $entry.Clear()
  $form.Dispose()
}
`;
}

function createPersonalTokenPrompt ({platform = process.platform, execute = run, exists = existsSync} = {}) {
  let program;
  let args;
  let cancelled;
  if (platform === 'darwin') {
    program = '/usr/bin/osascript';
    args = message => ['-e', macDialog, message];
    cancelled = error => error.code === 1 && /\(-128\)\s*$/u.test(error.stderr ?? '');
  } else if (platform === 'win32') {
    program = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    args = message => ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(windowsDialog(message), 'utf16le').toString('base64')];
    cancelled = error => error.code === 2;
  } else if (platform === 'linux') {
    if (exists('/usr/bin/zenity')) {
      program = '/usr/bin/zenity';
      args = message => ['--entry', '--hide-text', '--title', title, '--text', message];
    } else {
      program = '/usr/bin/kdialog';
      args = message => ['--title', title, '--password', message];
    }
    cancelled = error => error.code === 1;
  }
  if (!program || !exists(program)) return undefined;

  return async ({owner, repo}, signal) => {
    const message = 'Enter a fine-grained GitHub token for ' + owner + '/' + repo + '.\n' +
      'Limit it to this repository and Contents read or read/write. Set an expiration date.';
    try {
      const {stdout} = await execute(program, args(message), {signal, windowsHide: true, maxBuffer: 4096});
      return stdout.trim();
    } catch (error) {
      signal.throwIfAborted();
      if (cancelled(error)) return null;
      throw new GitServiceError(500, 'TOKEN_PROMPT_FAILED');
    }
  };
}

module.exports = {createPersonalTokenPrompt};
