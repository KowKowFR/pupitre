import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  importCompose,
  parseDuration,
  parseMemoryMi,
  renderComposeIssue,
  slugify,
  type ComposeImport,
} from '../src/compose/index.js';
import { parseAppSpec, type AppSpec } from '../src/spec/index.js';

/**
 * Importing a docker-compose.yml: what passes, what is approximated, what
 * blocks — and the fact that nothing goes unsaid.
 */

const codes = (result: ComposeImport, level?: string) =>
  result.issues.filter((issue) => !level || issue.level === level).map((issue) => issue.code);

function spec(result: ComposeImport): AppSpec {
  assert.ok(result.spec, 'an AppSpec is proposed');
  return parseAppSpec(result.spec);
}

describe('import docker-compose', () => {
  it('translates WordPress’s official compose file, secrets linked by alias', () => {
    const result = importCompose(
      `
services:
  db:
    image: mysql:8.0
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: somewordpress
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
    volumes:
      - db_data:/var/lib/mysql
  wordpress:
    depends_on:
      - db
    image: wordpress:latest
    ports:
      - "8000:80"
    restart: always
    environment:
      WORDPRESS_DB_HOST: db:3306
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
volumes:
  db_data: {}
`,
      { name: 'blog' },
    );

    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.deepEqual(codes(result, 'blocking'), []);
    const app = spec(result);
    assert.equal(app.name, 'blog');

    const [db, wordpress] = app.services;
    assert.equal(wordpress?.exposed, true);
    assert.equal(wordpress?.port, 80);
    assert.deepEqual(wordpress?.dependsOn, ['db']);
    assert.equal(db?.exposed, false);
    assert.equal(db?.port, 3306);
    assert.deepEqual(db?.volumes, [{ name: 'db-data', mountPath: '/var/lib/mysql' }]);

    // Passwords are never carried over in clear, and two names for the same value
    // become a secret and an alias.
    assert.deepEqual(db?.secrets, ['MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD']);
    assert.deepEqual(wordpress?.secrets, [
      { name: 'WORDPRESS_DB_PASSWORD', from: 'MYSQL_PASSWORD' },
    ]);
    assert.equal(db?.env.MYSQL_PASSWORD, undefined);
    assert.equal(db?.env.MYSQL_USER, 'wordpress');

    assert.ok(codes(result).includes('port.guessed'));
    assert.ok(codes(result).includes('port.hostIgnored'));
    assert.ok(codes(result).includes('env.secretAlias'));
    assert.ok(
      result.issues.some((issue) => issue.code === 'ignored' && issue.reason === 'restart'),
    );
  });

  it('blocks what leaves isolation, without translating it “as best it can”', () => {
    const result = importCompose(`
services:
  app:
    build:
      context: ./app
      dockerfile: docker/Dockerfile
      args:
        NODE_ENV: production
    command: ["node", "server.js"]
    privileged: true
    network_mode: host
    ports: ["3000:3000"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./uploads:/srv/uploads
      - /data
`);
    const blocking = codes(result, 'blocking');
    for (const code of ['command', 'volume.socket', 'volume.file', 'unsupported']) {
      assert.ok(blocking.includes(code as never), code);
    }
    const app = spec(result);
    const service = app.services[0];
    assert.deepEqual(service?.source, {
      type: 'dockerfile',
      context: './app',
      dockerfile: 'docker/Dockerfile',
    });
    // The host folder becomes a named volume, the socket and the file do not pass.
    assert.deepEqual(service?.volumes, [
      { name: 'uploads', mountPath: '/srv/uploads' },
      { name: 'data', mountPath: '/data' },
    ]);
    assert.ok(codes(result, 'warning').includes('volume.bind'));
    assert.ok(codes(result, 'warning').includes('build.args'));
  });

  it('takes the domain and the port from the Traefik labels', () => {
    const result = importCompose(`
services:
  whoami:
    image: traefik/whoami:v1.10
    labels:
      - traefik.enable=true
      - traefik.http.routers.whoami.rule=Host(\`whoami.example.com\`)
      - traefik.http.routers.whoami.tls.certresolver=le
      - traefik.http.services.whoami.loadbalancer.server.port=8080
`);
    const app = spec(result);
    assert.equal(app.services[0]?.port, 8080);
    assert.deepEqual(app.ingress, {
      host: 'whoami.example.com',
      tls: true,
      targetService: 'whoami',
    });
    assert.ok(codes(result).includes('ingress.traefik'));
  });

  it('reads the health probe, its delays and its resources', () => {
    const result = importCompose(`
services:
  api:
    image: ghcr.io/acme/api:2.1.0
    ports: ["3000"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
      interval: 1m30s
      timeout: 5s
      retries: 5
    deploy:
      replicas: 1
      resources:
        limits:
          cpus: "0.5"
          memory: 768M
  worker:
    image: ghcr.io/acme/worker:2.1.0
    healthcheck:
      test: ["CMD-SHELL", "pgrep node"]
`);
    const app = spec(result);
    const api = app.services[0];
    assert.equal(api?.healthcheck.path, '/healthz');
    assert.equal(api?.healthcheck.intervalSec, 90);
    assert.equal(api?.healthcheck.timeoutSec, 5);
    assert.equal(api?.healthcheck.retries, 5);
    assert.deepEqual(api?.resources, { cpuMilli: 500, memoryMi: 768 });
    // A non-HTTP probe on an internal service: it is probed over TCP, a mere info.
    const unparsed = result.issues.find((issue) => issue.code === 'healthcheck.unparsed');
    assert.equal(unparsed?.level, 'info');
  });

  it('resolves the shell variables and knows what is not a secret', () => {
    const result = importCompose(`
services:
  web:
    image: nginx:1.27
    ports: ["80:80"]
    environment:
      - LOG_LEVEL=\${LOG_LEVEL:-info}
      - PUBLIC_URL=\${PUBLIC_URL}
      - API_KEY=\${API_KEY}
      - PASSWORD_MIN_LENGTH=12
      - PRICE=$$5
      - lower_case=1
  cron:
    image: nginx:1.27
    environment:
      MAILER_API_KEY: \${API_KEY}
`);
    const app = spec(result);
    const [web, cron] = app.services;
    assert.equal(web?.env.LOG_LEVEL, 'info');
    assert.equal(web?.env.PUBLIC_URL, '');
    assert.equal(web?.env.PASSWORD_MIN_LENGTH, '12');
    assert.equal(web?.env.PRICE, '$5');
    assert.deepEqual(web?.secrets, ['API_KEY']);
    // Same shell variable, two names: a secret, an alias.
    assert.deepEqual(cron?.secrets, [{ name: 'MAILER_API_KEY', from: 'API_KEY' }]);
    assert.ok(codes(result, 'warning').includes('env.invalidName'));
    assert.equal(result.issues.filter((issue) => issue.code === 'env.interpolated').length, 2);
  });

  it('chooses a single exposed service, and says which', () => {
    const published = importCompose(`
services:
  admin:
    image: adminer:4
    ports: ["8081:8080"]
  web:
    image: nginx:1.27
    ports: ["8080:80"]
`);
    const app = spec(published);
    assert.equal(app.services.find((service) => service.exposed)?.name, 'web');
    assert.ok(codes(published, 'warning').includes('exposed.others'));

    const guessed = importCompose(`
services:
  cache:
    image: redis:7
  api:
    image: ghcr.io/acme/api:1.0.0
    expose: ["8080"]
`);
    const guessedSpec = spec(guessed);
    assert.equal(guessedSpec.services.find((service) => service.exposed)?.name, 'api');
    assert.ok(codes(guessed, 'warning').includes('exposed.guessed'));
  });

  it('renames the services to the AppSpec’s format, dependencies included', () => {
    const result = importCompose(`
x-common: &common
  restart: unless-stopped
services:
  My_Web:
    <<: *common
    image: nginx:1.27
    ports: ["80"]
    depends_on:
      Data_Base:
        condition: service_healthy
  Data_Base:
    <<: *common
    image: postgres:16
`);
    const app = spec(result);
    assert.deepEqual(
      app.services.map((service) => service.name),
      ['my-web', 'data-base'],
    );
    assert.deepEqual(app.services[0]?.dependsOn, ['data-base']);
    assert.ok(codes(result).includes('service.renamed'));
    assert.ok(codes(result).includes('dependsOn.condition'));
    assert.equal(result.valid, true);
  });

  it('cleanly refuses an unreadable, empty or booby-trapped file', () => {
    assert.deepEqual(codes(importCompose('services: [unclosed')), ['yaml.invalid']);
    assert.deepEqual(codes(importCompose('name: rien')), ['yaml.notCompose']);
    assert.equal(importCompose('services: [unclosed').spec, null);

    // A "billion laughs": alias expansion is bounded.
    const bomb = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      ...Array.from({ length: 8 }, (_, index) => {
        const name = String.fromCharCode(98 + index);
        const previous = String.fromCharCode(97 + index);
        return `${name}: &${name} [${Array(9).fill(`*${previous}`).join(',')}]`;
      }),
      'services: { web: { image: "nginx:1", x: *i } }',
    ].join('\n');
    assert.deepEqual(codes(importCompose(bomb)), ['yaml.invalid']);
  });

  it('renders each message in both languages, reasons included', () => {
    const result = importCompose(`
services:
  web:
    image: nginx
    container_name: legacy
    ports: ["80"]
    environment:
      HOME_URL: \${HOME_URL:-https://example.com}
`);
    for (const issue of result.issues) {
      for (const lang of ['fr', 'en'] as const) {
        const text = renderComposeIssue(issue, lang);
        assert.doesNotMatch(text, /\{\w+\}/, `${issue.code} (${lang}) : ${text}`);
      }
    }
    const ignored = result.issues.find((issue) => issue.reason === 'container_name');
    assert.ok(ignored);
    assert.match(
      renderComposeIssue(ignored, 'en'),
      /ignored: container names follow the application project/,
    );
    const interpolated = result.issues.find((issue) => issue.code === 'env.interpolated');
    assert.ok(interpolated);
    assert.match(
      renderComposeIssue(interpolated, 'en'),
      /its default value “https:\/\/example.com”/,
    );
  });
});

describe('reading Compose values', () => {
  it('reads durations, memory amounts and names', () => {
    assert.equal(parseDuration('1m30s'), 90);
    assert.equal(parseDuration('500ms'), 1);
    assert.equal(parseDuration('n/a'), null);
    assert.equal(parseMemoryMi('512m'), 512);
    assert.equal(parseMemoryMi('1.5G'), 1536);
    assert.equal(parseMemoryMi('1Gi'), 1024);
    assert.equal(parseMemoryMi(1073741824), 1024);
    assert.equal(slugify('Mon Service_2', 'x'), 'mon-service-2');
    assert.equal(slugify('é', 'x'), 'e-svc');
    assert.equal(slugify('___', 'fallback'), 'fallback');
  });
});
