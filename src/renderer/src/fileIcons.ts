// Which icon a file gets, by its name: Material Icon Theme's file icons (assets/fileicons, MIT).

const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('./assets/fileicons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>).map(([path, url]) => [path.split('/').pop()!.replace(/\.svg$/, ''), url])
)

/** Whole file names that say more than their ending. */
const BY_NAME: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  '.npmrc': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'composer.json': 'php',
  'composer.lock': 'php',
  artisan: 'laravel',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  '.dockerignore': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.env': 'tune',
  'readme.md': 'readme',
  readme: 'readme',
  'readme.txt': 'readme',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  makefile: 'makefile',
  'robots.txt': 'robots',
  '.htaccess': 'settings',
  '.user.ini': 'settings',
  '.editorconfig': 'editorconfig',
  '.prettierrc': 'prettier',
  'nginx.conf': 'nginx',
  'go.mod': 'go-mod',
  'go.sum': 'go-mod',
  'requirements.txt': 'python',
  '.bashrc': 'console',
  '.profile': 'console',
  '.bash_profile': 'console',
  '.zshrc': 'console',
  '.nvmrc': 'nodejs',
  '.node-version': 'nodejs'
}

const BY_EXT: Record<string, string> = {
  php: 'php', phtml: 'php',
  py: 'python', pyc: 'python', pyw: 'python',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less', styl: 'stylus',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'react', tsx: 'react_ts',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  json: 'json', json5: 'json', jsonc: 'json', map: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', xsd: 'xml', plist: 'xml',
  svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', ico: 'image', bmp: 'image', tif: 'image', tiff: 'image',
  pdf: 'pdf',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', rar: 'zip', '7z': 'zip', zst: 'zip',
  sql: 'database', sqlite: 'database', sqlite3: 'database', db: 'database', dump: 'database',
  log: 'log',
  lock: 'lock',
  ini: 'settings', conf: 'settings', cfg: 'settings', cnf: 'settings', properties: 'settings', config: 'settings',
  toml: 'toml',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  ps1: 'powershell', psm1: 'powershell',
  go: 'go',
  rb: 'ruby', erb: 'ruby',
  java: 'java', jar: 'java', class: 'java',
  kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  rs: 'rust', cs: 'csharp', swift: 'swift', lua: 'lua', dart: 'dart', pl: 'perl', pm: 'perl', r: 'r', ex: 'elixir', exs: 'elixir',
  txt: 'document', text: 'document', rtf: 'document',
  doc: 'word', docx: 'word', odt: 'word',
  xls: 'table', xlsx: 'table', csv: 'table', tsv: 'table', ods: 'table',
  ppt: 'powerpoint', pptx: 'powerpoint',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
  pem: 'certificate', crt: 'certificate', cer: 'certificate', csr: 'certificate', p12: 'certificate', pfx: 'certificate',
  key: 'key', pub: 'key',
  twig: 'twig', ejs: 'ejs', pug: 'pug', hbs: 'handlebars', handlebars: 'handlebars', mustache: 'handlebars',
  graphql: 'graphql', gql: 'graphql', proto: 'proto', tf: 'terraform', http: 'http', gradle: 'gradle', exe: 'exe', coffee: 'coffee'
}

/** The icon for a file name, or the plain file icon. */
export function fileIconUrl(fileName: string): string {
  const name = fileName.toLowerCase()
  let key = BY_NAME[name]
  if (!key && name.endsWith('.blade.php')) key = 'laravel'
  if (!key && name.startsWith('.env.')) key = 'tune'
  if (!key && name.startsWith('dockerfile')) key = 'docker'
  if (!key && /^(vite|vitest)\.config\./.test(name)) key = 'vite'
  if (!key && /^webpack\.config\./.test(name)) key = 'webpack'
  if (!key && /^tailwind\.config\./.test(name)) key = 'tailwindcss'
  if (!key && /^\.eslintrc/.test(name)) key = 'eslint'
  if (!key && /^\.prettierrc/.test(name)) key = 'prettier'
  if (!key && name.includes('.')) key = BY_EXT[name.slice(name.lastIndexOf('.') + 1)]
  return URLS[key ?? 'file'] ?? URLS.file
}
