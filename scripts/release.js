// Builds the Windows installer and publishes it to GitHub Releases.
//
// Why this exists: electron-builder uploads the installer and the blockmap in
// parallel, and each upload tries to create the GitHub release if it is
// missing. Both race to create it, GitHub rejects the second with
// "422 tag already exists", and the run dies before the installer is uploaded.
// Creating the release first, before electron-builder starts, removes the race.
//
// Run with `npm run release` (reads GH_TOKEN from .env).
// `npm run release -- --check` only creates or reports the release, without building.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const { owner, repo } = pkg.build.publish[0];
const tag = `v${pkg.version}`;
const token = process.env.GH_TOKEN;
const api = `https://api.github.com/repos/${owner}/${repo}`;
const TWO_HOURS = 2 * 60 * 60 * 1000;

async function github(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'communicator-release-script',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

async function ensureRelease() {
  const found = await github('GET', `${api}/releases/tags/${tag}`);
  if (found.status === 200) {
    const rel = found.data;
    const age = Date.now() - new Date(rel.published_at || rel.created_at).getTime();
    const files = rel.assets.map((a) => a.name);
    console.log(`Release ${tag} already exists (assets: ${files.join(', ') || 'none'}).`);
    if (!rel.draft && age > TWO_HOURS) {
      // electron-builder refuses to add files to a release older than 2 hours.
      throw new Error(
        `${tag} was published more than 2 hours ago, so electron-builder will skip uploading. ` +
        `Bump "version" in package.json for a new release, or delete the ${tag} release and tag on GitHub first.`,
      );
    }
    return;
  }
  if (found.status !== 404) {
    throw new Error(`Could not look up release ${tag}: HTTP ${found.status} ${found.data && found.data.message}`);
  }

  const created = await github('POST', `${api}/releases`, {
    tag_name: tag,
    target_commitish: 'main',
    name: pkg.version,
    draft: false,
    prerelease: false,
  });
  if (created.status !== 201) {
    throw new Error(`Could not create release ${tag}: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  }
  console.log(`Created release ${tag}.`);
}

async function main() {
  if (!token) throw new Error('GH_TOKEN is missing. Put it in .env (see .env.example).');
  await ensureRelease();
  if (process.argv.includes('--check')) return;

  const cli = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js');
  const run = spawnSync(process.execPath, [cli, '--win', '--publish', 'always'], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}

main().catch((err) => {
  console.error(`\nRelease failed: ${err.message}`);
  process.exitCode = 1;
});
