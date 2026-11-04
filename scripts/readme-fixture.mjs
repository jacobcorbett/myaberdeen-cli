// Documentation-only fixture: never opens Chrome or reads the user's config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArchiveDatabase } from '../src/database.js';
import { storeRecording, viewerUrl } from '../src/panopto-data.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'docs/media');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-readme-'));
const course = '_demo_1';
const recording = '11111111-1111-1111-1111-111111111111';
let database;
try {
  fs.mkdirSync(destination, { recursive: true });
  const state = path.join(temporary, 'state');
  const vault = path.join(temporary, 'vault');
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(vault, 'Uni'), { recursive: true });
  const configPath = path.join(state, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ profiles: { current: [course] } }));
  const databasePath = path.join(state, 'myaberdeen.sqlite');
  database = new ArchiveDatabase(databasePath);
  database.upsertCourse({ id: course, courseId: 'CS1000_27', name: 'Example Computing', isAvailable: true }, '2026-27');
  const run = database.startRun();
  const content = { id: '_welcome_1', title: 'Start here', body: '<p>Welcome to this synthetic demonstration course.</p>', contentHandler: { id: 'resource/x-bb-document' } };
  database.upsertContent(course, null, content);
  database.observe('content', course, content.id, content, { title: content.title });
  database.upsertAnnouncement(course, { id: '_notice_1', title: 'Week 1 materials', body: '<p>The example materials are ready to read offline.</p>' });
  storeRecording(database, course, {
    id: recording, title: 'How computers represent information', url: viewerUrl(recording), duration: 2700,
    description: 'Synthetic lecture for the README demonstration.',
    chapters: [{ start: 0, title: 'Introduction' }, { start: 12, title: 'Binary representation' }],
    transcripts: { English: { automatic: true, captions: [
      { start: 0, duration: 5, text: 'Welcome. Today we will look at binary representation.' },
      { start: 5, duration: 7, text: 'A bit can hold one of two values: zero or one.' },
      { start: 12, duration: 8, text: 'Eight bits form a byte, giving 256 possible combinations.' },
      { start: 20, duration: 6, text: 'We can use those patterns to represent numbers and text.' }
    ] } }
  });
  for (const section of ['content', 'announcements', 'grades', 'schedule', 'messages', 'discussions', 'panopto']) database.finishSection(run, course, section, 'completed');
  database.finishRun(run, 'completed', 1);
  database.close(); database = null;

  // Only pass known environment values. Every private data location is isolated.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_NO_WARNINGS: '1',
    MYAB_STATE_DIR: state, MYAB_CONFIG: configPath, MYAB_DATABASE: databasePath,
    MYAB_PROFILE_DIR: path.join(state, 'unused-profile'), MYAB_DOWNLOAD_DIR: path.join(temporary, 'downloads'), MYAB_VAULT: vault };
  function cli(args) {
    const result = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), ...args], { env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `CLI exited ${result.status}`);
    return result.stdout;
  }
  function jq(input, expression) {
    const result = spawnSync('jq', [expression], { input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }
  const briefFilter = '.courses[] | {code, name, stale}';
  const searchFilter = '.[] | {title, matches: [.matches[] | {start, text}]}';
  const scenes = [
    { title: '01 / Read your local archive', note: 'After login, setup and a scoped refresh. No browser needed here.',
      command: `myab brief --active --json | jq '${briefFilter}'`,
      output: jq(cli(['brief', '--active', '--json']), briefFilter) },
    { title: '02 / Find a moment in a lecture', note: 'Search the captions already saved in your archive.',
      command: `myab recordings --course CS1000_27 --search "byte" |\n  jq '${searchFilter}'`,
      output: jq(cli(['recordings', '--course', 'CS1000_27', '--search', 'byte']), searchFilter) },
    { title: '03 / Read the transcript offline', note: 'Caption timestamps stay attached to the text.',
      command: `myab transcript --course CS1000_27 \\\n  --id ${recording}`,
      output: cli(['transcript', '--course', 'CS1000_27', '--id', recording]) }
  ];
  // Run the actual exporter and vault integration against the temporary fixture.
  cli(['export', '--active']);
  cli(['merge-vault', '--active', '--keep-duplicates']);
  function find(directory, basename) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { const found = find(target, basename); if (found) return found; }
      else if (entry.name === basename) return target;
    }
  }
  const index = fs.readFileSync(find(vault, 'Index.md'), 'utf8').replaceAll(temporary, '/demo');
  const transcript = fs.readFileSync(path.join(temporary, 'downloads/2026-27/CS1000_27/recordings', recording, 'README.md'), 'utf8');
  const data = { synthetic: true, scenes, index, transcript };
  fs.writeFileSync(path.join(destination, 'demo.json'), JSON.stringify(data, null, 2) + '\n');
  console.log('Captured three offline CLI scenes and generated Markdown from synthetic data.');
} finally {
  database?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
