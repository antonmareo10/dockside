#!/usr/bin/env node
// Builds the app with the Forge CLI's own bundlers (backend functions and UI Kit
// resources) without logging in or uploading anything. This is the packaging step
// `forge deploy` runs before the upload, so a pass here means the code bundles.

const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const fromCli = (id) => require(require.resolve(id, { paths: [path.join(root, 'node_modules/@forge/cli')] }));

const cliShared = fromCli('@forge/cli-shared');
const bundler = fromCli('@forge/bundler');

(async () => {
  const ui = new cliShared.CommandLineUI(() => false);
  const fileReader = new cliShared.FileSystemReader();
  const configFile = new cliShared.ConfigFile(fileReader, new cliShared.FileSystemWriter());

  const handlers = await configFile.getAppHandlers();
  const entryPoints = bundler.getEntryPoints(handlers);
  const nodeBundler = bundler.getNodeBundler(ui, bundler.getWrapperProvider({ fileSystemReader: fileReader }), configFile);
  const backend = await nodeBundler.bundle({ appDirectory: root, entryPoints });
  console.log(`Backend bundle: ${entryPoints.length} entry point(s) [${entryPoints.map((e) => e.name).join(', ')}] -> ${backend.outputDir}`);

  const resources = await configFile.getResources(['nativeUI']);
  const nativeUi = new bundler.NativeUIBundler(ui);
  const ui2 = await nativeUi.bundleResources(resources);
  console.log(`UI Kit bundles: ${ui2.nativeUiBundlesDetails.map((r) => r.key).join(', ')}`);
  console.log('Bundle check passed.');
})().catch((e) => {
  console.error('Bundle check FAILED:', e?.message ?? e);
  process.exit(1);
});
