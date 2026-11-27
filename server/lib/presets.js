'use strict';
/**
 * Framework presets: pick a framework, everything else (build, start, serving mode, health, shared folders,
 * required tools, nginx shape) is pre-filled. Raw commands are only an "Advanced" override.
 *
 * mode:
 *   service - a long-running process on $PORT behind an nginx reverse proxy (Express, Nest, Next.js, Spring, .NET, Go, Python...)
 *   static  - a build folder served directly by nginx, no process (React, Vue, Angular, Vite, plain HTML)
 *   php     - PHP-FPM + nginx fastcgi, no process of its own (Laravel and other PHP apps)
 *
 * `detect` is a POSIX test run inside a fresh checkout (first match wins, so order matters).
 */
const NPM_INSTALL = 'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f yarn.lock ] && command -v yarn >/dev/null; then yarn install --frozen-lockfile; elif [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null; then pnpm install --frozen-lockfile; else npm install --no-audit --no-fund; fi';
const NPM_BUILD = `if node -e "const s=require('./package.json').scripts;process.exit(s&&s.build?0:1)"; then npm run build; else echo "(no build script - skipping)"; fi`;
const hasDep = (name) => `grep -q '"${name}"' package.json 2>/dev/null`;

const PRESETS = [
  {
    id: 'laravel', label: 'Laravel / PHP', group: 'PHP', mode: 'php', icon: '🐘', tools: ['php', 'composer'],
    description: 'Composer install, optional asset build, database migrations, shared storage, PHP-FPM reload.',
    detect: '[ -f artisan ] && [ -f composer.json ]',
    install: 'composer install --no-dev --optimize-autoloader --no-interaction --prefer-dist',
    build: 'if [ -f package.json ] && command -v npm >/dev/null; then npm ci --no-audit --no-fund && npm run build; else echo "(no front-end build)"; fi; php artisan config:cache && php artisan route:cache && php artisan view:cache',
    releaseCmd: 'php artisan migrate --force', afterCmd: 'php artisan queue:restart',
    reloadCmd: 'php artisan config:cache && php artisan queue:restart',
    outputDir: 'public', sharedPaths: ['storage'], healthPath: '/', spa: false,
  },
  {
    id: 'php', label: 'PHP (plain / WordPress / other)', group: 'PHP', mode: 'php', icon: '🐘', tools: ['php'],
    description: 'PHP files served through PHP-FPM; optional Composer install.',
    detect: '[ -f index.php ] || [ -f composer.json ]',
    install: 'if [ -f composer.json ]; then composer install --no-dev --optimize-autoloader --no-interaction; else echo "(no composer.json)"; fi',
    build: '', releaseCmd: '', afterCmd: '', outputDir: '.', sharedPaths: [], healthPath: '/', spa: false,
  },
  {
    id: 'nextjs', label: 'Next.js', group: 'Node.js', mode: 'service', icon: '▲', tools: ['node'],
    description: 'next build, then next start on the assigned port.', detect: hasDep('next'),
    install: NPM_INSTALL, build: 'npm run build', start: 'npm start', healthPath: '/', sharedPaths: [],
  },
  {
    id: 'nestjs', label: 'NestJS', group: 'Node.js', mode: 'service', icon: '🐈', tools: ['node'],
    description: 'nest build, then node dist/main.js.', detect: hasDep('@nestjs/core'),
    install: NPM_INSTALL, build: 'npm run build', start: 'node dist/main.js', healthPath: '/', sharedPaths: [],
  },
  {
    id: 'nuxt', label: 'Nuxt', group: 'Node.js', mode: 'service', icon: '💚', tools: ['node'],
    description: 'nuxt build, then the Nitro server.', detect: hasDep('nuxt'),
    install: NPM_INSTALL, build: 'npm run build', start: 'node .output/server/index.mjs', healthPath: '/', sharedPaths: [],
  },
  {
    id: 'static-spa', label: 'React / Vue / Angular / Vite (static build)', group: 'Frontend', mode: 'static', icon: '⚛', tools: ['node'],
    description: 'Builds the front end and serves the result straight from nginx (no process). Client-side routing works (index.html fallback).',
    detect: `{ ${hasDep('react-scripts')} || ${hasDep('vite')} || ${hasDep('@angular/core')} || ${hasDep('vue')} || ${hasDep('@vue/cli-service')} || ${hasDep('parcel')}; } && ! ${hasDep('next')} && ! ${hasDep('@nestjs/core')}`,
    install: NPM_INSTALL, build: NPM_BUILD, outputDir: 'auto', sharedPaths: [], healthPath: '/', spa: true,
  },
  {
    id: 'static-html', label: 'Plain HTML / static site', group: 'Frontend', mode: 'static', icon: '📄', tools: [],
    description: 'Serves the repository (or its public/ folder) as it is. No build.', detect: '[ -f index.html ]',
    install: '', build: '', outputDir: 'auto', sharedPaths: [], healthPath: '/', spa: false,
  },
  {
    id: 'node', label: 'Express / Fastify / other Node.js server', group: 'Node.js', mode: 'service', icon: '🟢', tools: ['node'],
    description: 'npm install, optional build, npm start on the assigned port (read it from process.env.PORT).',
    detect: '[ -f package.json ]', install: NPM_INSTALL, build: NPM_BUILD, start: 'npm start', healthPath: '/', sharedPaths: [],
  },
  {
    id: 'spring', label: 'Spring Boot (Java)', group: 'Java', mode: 'service', icon: '🍃', tools: ['java'],
    description: 'Maven or Gradle (wrapper if present) builds the jar, which is started with java -jar on the assigned port.',
    detect: '[ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ]',
    install: '',
    build: 'if [ -x ./mvnw ]; then ./mvnw -B -DskipTests package; elif [ -f pom.xml ]; then mvn -B -DskipTests package; elif [ -x ./gradlew ]; then ./gradlew build -x test --no-daemon; else gradle build -x test --no-daemon; fi',
    start: 'exec java $JAVA_OPTS -jar "$(ls -1 target/*.jar build/libs/*.jar 2>/dev/null | grep -vE -- "-plain|original" | head -1)" --server.port=$PORT --server.address=127.0.0.1',
    healthPath: '/', healthTimeout: 90, sharedPaths: [],
  },
  {
    id: 'dotnet', label: '.NET / ASP.NET Core', group: '.NET', mode: 'service', icon: '🟣', tools: ['dotnet'],
    description: 'dotnet publish, then the published app on the assigned port.',
    detect: '[ -n "$(find . -maxdepth 3 \\( -name \'*.csproj\' -o -name \'*.sln\' \\) -not -path \'./node_modules/*\' | head -1)" ]',
    install: 'dotnet restore',
    build: 'dotnet publish -c Release -o out --no-restore',
    start: 'exec dotnet "out/$(basename "$(ls -1 out/*.runtimeconfig.json | head -1)" .runtimeconfig.json).dll" --urls "http://127.0.0.1:$PORT"',
    healthPath: '/', healthTimeout: 60, sharedPaths: [],
  },
  {
    id: 'go', label: 'Go', group: 'Other', mode: 'service', icon: '🐹', tools: ['go'],
    description: 'go build, then the binary on the assigned port (read PORT from the environment).',
    detect: '[ -f go.mod ]', install: 'go mod download', build: 'go build -o app .', start: 'exec ./app', healthPath: '/', sharedPaths: [],
  },
  {
    id: 'python', label: 'Python (Django / Flask / FastAPI)', group: 'Other', mode: 'service', icon: '🐍', tools: ['python'],
    description: 'Creates a virtualenv, installs requirements.txt and runs your start command (default: gunicorn app:app).',
    detect: '[ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f manage.py ]',
    install: 'python3 -m venv .venv && if [ -f requirements.txt ]; then .venv/bin/pip install -r requirements.txt; fi',
    build: '', start: 'exec .venv/bin/gunicorn --bind 127.0.0.1:$PORT app:app', healthPath: '/', sharedPaths: [],
  },
  {
    id: 'custom', label: 'Custom (any app, my own commands)', group: 'Other', mode: 'service', icon: '⚙', tools: [],
    description: 'You provide the build and start commands; the app must listen on the assigned port.', detect: 'false',
    install: '', build: '', start: '', healthPath: '/', sharedPaths: [],
  },
];

const BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

/**
 * The effective configuration of an app. The app's own setting wins when it is set; an explicitly EMPTY
 * releaseCmd/afterCmd switches the preset default off (e.g. "do not run migrations").
 */
function resolve(app) {
  const p = BY_ID[app.framework] || BY_ID.node;
  const own = (k) => (app[k] !== undefined && app[k] !== null && app[k] !== '' ? app[k] : undefined);
  return {
    preset: p.id, mode: p.mode, tools: p.tools || [],
    install: own('installCmd') ?? p.install ?? '',
    build: own('buildCmd') ?? p.build ?? '',
    start: own('startCmd') ?? p.start ?? 'npm start',
    releaseCmd: app.releaseCmd !== undefined && app.releaseCmd !== null ? app.releaseCmd : (p.releaseCmd || ''),
    afterCmd: app.afterCmd !== undefined && app.afterCmd !== null ? app.afterCmd : (p.afterCmd || ''),
    reloadCmd: p.reloadCmd || '',
    outputDir: own('outputDir') ?? p.outputDir ?? '',
    sharedPaths: Array.isArray(app.sharedPaths) ? app.sharedPaths : (p.sharedPaths || []),
    healthPath: own('healthPath') ?? p.healthPath ?? '/',
    healthTimeout: own('healthTimeout') ?? p.healthTimeout ?? 30,
    spa: app.spa !== undefined ? !!app.spa : !!p.spa,
  };
}

/** bash that prints the id of the first preset whose detect test matches the current directory. */
function detectScript() {
  const arms = PRESETS.filter((p) => p.detect !== 'false').map((p, i) => `${i ? 'elif' : 'if'} ${p.detect}; then echo ${p.id}`);
  return `${arms.join('\n')}\nelse echo custom\nfi`;
}

const publicPresets = () => PRESETS.map(({ detect, ...rest }) => rest);

module.exports = { PRESETS, BY_ID, resolve, detectScript, publicPresets, NPM_INSTALL, NPM_BUILD };
