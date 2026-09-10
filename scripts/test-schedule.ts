/**
 * Aller-retour entre périodicité simplifiée et expression cron.
 *
 *   pnpm test:schedule
 *
 * Ce qui est prouvé ici :
 *   1. `toCron` → `fromCron` → `toCron` est l'identité sur tout l'espace des
 *      `SimpleSchedule` (exhaustif : 4 intervalles, 60 minutes, 24×60 heures,
 *      127 combinaisons de jours, 31 jours du mois — échantillonné où le
 *      produit cartésien devient absurde).
 *   2. `fromCron` → `toCron` → `fromCron` est l'identité sur les expressions
 *      qu'il accepte.
 *   3. `fromCron` rend `null` — et pas une approximation — sur les formes qui
 *      n'ont pas d'équivalent simple.
 *   4. `describeCron` ne rend jamais l'expression brute pour une expression que
 *      `fromCron` accepte, et ne ment pas sur celles qu'il rejette.
 *   5. `nextRuns` tombe sur des instants qui satisfont réellement l'expression,
 *      dans le fuseau demandé.
 *   6. Le fuseau est bien un **réglage de la tâche** : la même expression dans
 *      deux fuseaux tombe sur deux instants différents, et l'instant UTC d'une
 *      heure locale fixe suit le passage à l'heure d'été.
 *   7. `scheduleTimeZoneSchema` refuse un fuseau IANA inventé.
 *
 * Sortie en code 1 dès qu'un seul point échoue.
 */
import assert from 'node:assert/strict';
import {
  LEGACY_SCHEDULE_TIMEZONE,
  SIMPLE_INTERVAL_MINUTES,
  cronError,
  describeCron,
  fromCron,
  nextRuns,
  scheduleTimeZoneSchema,
  simpleScheduleSchema,
  toCron,
  type SimpleSchedule,
} from '@tp/core';

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const bold = paint('1');
const green = paint('32');
const red = paint('31');
const dim = paint('2');

let failures = 0;
let checks = 0;

function step(title: string): void {
  process.stdout.write(`\n${bold(title)}\n`);
}

function ok(message: string): void {
  process.stdout.write(`  ${green('✓')} ${message}\n`);
}

function ko(message: string, detail: string): void {
  failures += 1;
  process.stdout.write(`  ${red('✗')} ${message}\n      ${dim(detail)}\n`);
}

function check(message: string, run: () => void): void {
  checks += 1;
  try {
    run();
    ok(message);
  } catch (error) {
    ko(message, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
  }
}

/** Toutes les combinaisons de jours de semaine non vides : 2⁷ − 1 = 127. */
function everyWeekdayCombination(): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 128; mask += 1) {
    const days: number[] = [];
    for (let day = 0; day < 7; day += 1) if (mask & (1 << day)) days.push(day);
    out.push(days);
  }
  return out;
}

/** L'espace complet des périodicités simplifiées, échantillonné où il le faut. */
function everySimpleSchedule(): SimpleSchedule[] {
  const out: SimpleSchedule[] = [];

  for (const everyMinutes of SIMPLE_INTERVAL_MINUTES) {
    out.push({ kind: 'interval', everyMinutes });
  }
  for (let minute = 0; minute < 60; minute += 1) {
    out.push({ kind: 'hourly', minute });
  }
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      out.push({ kind: 'daily', hour, minute });
    }
  }
  for (const weekdays of everyWeekdayCombination()) {
    // Un couple heure/minute par combinaison suffit : les deux dimensions sont
    // indépendantes, et le cas `daily` couvre déjà les 1440 minutes.
    out.push({ kind: 'weekly', weekdays, hour: weekdays.length % 24, minute: 7 });
  }
  for (let day = 1; day <= 31; day += 1) {
    out.push({ kind: 'monthly', day, hour: day % 24, minute: (day * 2) % 60 });
  }

  return out;
}

step('1. toCron → fromCron → toCron est l’identité');
{
  const all = everySimpleSchedule();
  const broken: string[] = [];

  for (const simple of all) {
    const cron = toCron(simple);
    if (cronError(cron) !== null) {
      broken.push(`${JSON.stringify(simple)} produit « ${cron} », refusée par cronError`);
      continue;
    }
    const back = fromCron(cron);
    if (!back) {
      broken.push(`${JSON.stringify(simple)} → « ${cron} » → fromCron a rendu null`);
      continue;
    }
    const again = toCron(back);
    if (again !== cron) {
      broken.push(`« ${cron} » → ${JSON.stringify(back)} → « ${again} »`);
      continue;
    }
    // La périodicité relue doit aussi passer le schéma : ce n'est pas parce que
    // le cron retombe juste que l'objet est valide.
    const parsed = simpleScheduleSchema.safeParse(back);
    if (!parsed.success) broken.push(`${JSON.stringify(back)} ne passe pas le schéma Zod`);
  }

  checks += 1;
  if (broken.length === 0) {
    ok(`${all.length} périodicités, aller-retour exact`);
  } else {
    ko(`${broken.length} aller-retour(s) rompu(s) sur ${all.length}`, broken.slice(0, 5).join(' | '));
  }
}

step('2. fromCron → toCron → fromCron est l’identité');
{
  const accepted = [
    '*/5 * * * *',
    '*/10 * * * *',
    '*/15 * * * *',
    '*/30 * * * *',
    '0 * * * *',
    '17 * * * *',
    '0 3 * * *',
    '30 3 * * *',
    '0 4 * * 1',
    '0 3 * * 1,3,5',
    '0 3 * * 0,6',
    '0 3 15 * *',
    '0 3 31 * *',
    // Formes équivalentes, normalisées par l'aller-retour.
    '0 3 * * 7', // 7 = dimanche = 0
    '0 3 * * mon', // alias
    '0 3 * * MON,WED',
    '0 0 3 * * *', // six champs, seconde = 0
  ];

  for (const expression of accepted) {
    check(`« ${expression} » relue en mode simple`, () => {
      const simple = fromCron(expression);
      assert.ok(simple, `fromCron a rendu null pour « ${expression} »`);
      const cron = toCron(simple);
      const again = fromCron(cron);
      assert.ok(again, `fromCron a rendu null pour « ${cron} »`);
      assert.deepEqual(again, simple, 'la relecture ne rend pas la même périodicité');
      assert.equal(toCron(again), cron, 'le cron normalisé n’est pas stable');
    });
  }
}

step('3. fromCron rend null plutôt qu’une approximation');
{
  const rejected: Array<[string, string]> = [
    ['*/7 2-5 * * 1,3', 'pas exotique, plage d’heures et liste de jours'],
    ['*/7 * * * *', 'intervalle hors des choix proposés'],
    ['0 */3 * * *', 'pas dans le champ heure'],
    ['0 2-5 * * *', 'plage d’heures'],
    ['0 3 1 1 *', 'mois restreint'],
    ['0 3 1 * 1', 'jour du mois ET jour de semaine — cron les traite en OU'],
    ['* * * * *', 'chaque minute'],
    ['* 3 * * *', 'toutes les minutes d’une heure'],
    ['0,30 3 * * *', 'liste de minutes'],
    ['0 3 * * 1-5', 'plage de jours'],
    ['30 0 3 * * *', 'six champs, seconde ≠ 0'],
    ['0 3 * *', 'quatre champs'],
    ['0 99 * * *', 'heure hors bornes'],
    ['pas du tout un cron', 'texte libre'],
  ];

  for (const [expression, why] of rejected) {
    check(`« ${expression} » → null (${why})`, () => {
      assert.equal(fromCron(expression), null, `fromCron a accepté « ${expression} »`);
    });
  }
}

step('4. describeCron ne ment jamais');
{
  const cases: Array<[string, string]> = [
    ['*/15 * * * *', 'toutes les 15 minutes'],
    ['0 * * * *', 'toutes les heures, à l’heure pile'],
    ['17 * * * *', 'toutes les heures, à la minute 17'],
    ['0 3 * * *', 'tous les jours à 03:00 (UTC)'],
    ['30 3 * * 1', 'les lundis à 03:30 (UTC)'],
    ['0 4 * * 1,3,5', 'les lundis, mercredis et vendredis à 04:00 (UTC)'],
    ['0 3 * * 0,1,2,3,4,5,6', 'tous les jours à 03:00 (UTC)'],
    ['0 2 1 * *', 'le 1er de chaque mois à 02:00 (UTC)'],
    ['0 2 15 * *', 'le 15 de chaque mois à 02:00 (UTC)'],
  ];

  for (const [expression, expected] of cases) {
    check(`« ${expression} » → ${expected}`, () => {
      assert.equal(describeCron(expression, { timeZone: 'UTC' }), expected);
    });
  }

  check('locale anglaise', () => {
    assert.equal(
      describeCron('0 3 * * 1', { locale: 'en', timeZone: 'UTC' }),
      'on Mondays at 03:00 (UTC)',
    );
  });

  // Les expressions que fromCron refuse doivent quand même être décrites, sans
  // arrondi : c'est tout l'objet de la fonction.
  const approximated: Array<[string, string]> = [
    ['*/7 2-5 * * 1,3', 'toutes les 7 minutes, entre 2 h et 5 h 59, les lundis et mercredis (UTC)'],
    ['0 */3 * * *', 'à 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00 et 21:00 (UTC)'],
    ['0 3 1 * 1', 'à 03:00, le 1 du mois ou les lundis (UTC)'],
    ['* * * * *', 'chaque minute'],
  ];
  for (const [expression, expected] of approximated) {
    check(`« ${expression} » décrite sans arrondi`, () => {
      const described = describeCron(expression, { timeZone: 'UTC' });
      assert.notEqual(described, expression, 'rendue brute alors qu’elle est descriptible');
      assert.equal(described, expected);
    });
  }

  check('une expression invalide est rendue telle quelle', () => {
    assert.equal(describeCron('0 99 * * *'), '0 99 * * *');
    assert.equal(describeCron('n’importe quoi'), 'n’importe quoi');
  });

  check('un intervalle ne porte pas de fuseau — il n’en dépend pas', () => {
    assert.equal(describeCron('*/5 * * * *', { timeZone: 'Europe/Paris' }), 'toutes les 5 minutes');
  });
}

step('5. nextRuns tombe sur des instants qui satisfont l’expression');
{
  const from = new Date('2026-03-10T12:34:56.000Z');

  check('« 0 3 * * * » en UTC → 03:00 UTC chaque jour', () => {
    const runs = nextRuns('0 3 * * *', { from, count: 3, timeZone: 'UTC' });
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      ['2026-03-11T03:00:00.000Z', '2026-03-12T03:00:00.000Z', '2026-03-13T03:00:00.000Z'],
    );
  });

  check('« 0 3 * * * » en Europe/Paris → 02:00 UTC (heure d’hiver)', () => {
    const winter = new Date('2026-01-10T12:00:00.000Z');
    const runs = nextRuns('0 3 * * *', { from: winter, count: 1, timeZone: 'Europe/Paris' });
    assert.equal(runs[0]?.toISOString(), '2026-01-11T02:00:00.000Z');
  });

  check('« 0 4 * * 1 » → un lundi', () => {
    const runs = nextRuns('0 4 * * 1', { from, count: 2, timeZone: 'UTC' });
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(run.getUTCDay(), 1, `${run.toISOString()} n’est pas un lundi`);
    assert.equal(runs[0]?.toISOString(), '2026-03-16T04:00:00.000Z');
  });

  check('« */15 * * * * » → quatre occurrences par heure', () => {
    const runs = nextRuns('*/15 * * * *', { from, count: 4, timeZone: 'UTC' });
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      [
        '2026-03-10T12:45:00.000Z',
        '2026-03-10T13:00:00.000Z',
        '2026-03-10T13:15:00.000Z',
        '2026-03-10T13:30:00.000Z',
      ],
    );
  });

  check('« 0 3 31 * * » saute les mois trop courts', () => {
    const runs = nextRuns('0 3 31 * *', { from, count: 3, timeZone: 'UTC' });
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      ['2026-03-31T03:00:00.000Z', '2026-05-31T03:00:00.000Z', '2026-07-31T03:00:00.000Z'],
    );
  });

  check('« 0 3 1 * 1 » : jour du mois OU jour de semaine', () => {
    const runs = nextRuns('0 3 1 * 1', { from, count: 4, timeZone: 'UTC' });
    for (const run of runs) {
      assert.ok(
        run.getUTCDate() === 1 || run.getUTCDay() === 1,
        `${run.toISOString()} n’est ni un 1er ni un lundi`,
      );
    }
  });

  check('une expression invalide ne rend aucune occurrence', () => {
    assert.deepEqual(nextRuns('0 99 * * *'), []);
    assert.deepEqual(nextRuns('n’importe quoi'), []);
  });

  check('toutes les occurrences sont strictement postérieures à « from »', () => {
    for (const expression of ['*/5 * * * *', '0 3 * * *', '0 4 * * 1,3', '0 2 15 * *']) {
      for (const run of nextRuns(expression, { from, count: 5, timeZone: 'UTC' })) {
        assert.ok(run.getTime() > from.getTime(), `${expression} : ${run.toISOString()} ≤ from`);
      }
    }
  });
}

step('6. Le fuseau est un réglage de la tâche, pas du process');
{
  /** Heure murale d'un instant, lue dans un fuseau. */
  const wallClock = (date: Date, timeZone: string): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);

  check('la même expression dans deux fuseaux → deux instants différents', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const utc = nextRuns('0 3 * * *', { from, count: 1, timeZone: 'UTC' })[0];
    const paris = nextRuns('0 3 * * *', { from, count: 1, timeZone: 'Europe/Paris' })[0];
    const tokyo = nextRuns('0 3 * * *', { from, count: 1, timeZone: 'Asia/Tokyo' })[0];
    assert.ok(utc && paris && tokyo);
    assert.equal(utc.toISOString(), '2026-07-01T03:00:00.000Z');
    // Paris en juillet : UTC+2.
    assert.equal(paris.toISOString(), '2026-07-01T01:00:00.000Z');
    // Tokyo : UTC+9, toute l'année — 00:00 UTC y est déjà 09:00, la prochaine
    // occurrence à 3 h locale est donc celle du lendemain.
    assert.equal(tokyo.toISOString(), '2026-07-01T18:00:00.000Z');
    assert.notEqual(utc.getTime(), paris.getTime());
    assert.notEqual(paris.getTime(), tokyo.getTime());
  });

  // Le cœur du sujet : « 3 h à Paris » ne désigne PAS le même instant en janvier
  // et en juillet. C'est exactement ce qu'un cron interprété en UTC ne sait pas
  // faire — et la raison d'être de l'option `tz`.
  check('« 0 3 * * * » à Paris : 02:00 UTC en hiver, 01:00 UTC en été', () => {
    const winter = nextRuns('0 3 * * *', {
      from: new Date('2026-01-10T12:00:00.000Z'),
      count: 1,
      timeZone: 'Europe/Paris',
    })[0];
    const summer = nextRuns('0 3 * * *', {
      from: new Date('2026-07-10T12:00:00.000Z'),
      count: 1,
      timeZone: 'Europe/Paris',
    })[0];
    assert.ok(winter && summer);
    assert.equal(winter.toISOString(), '2026-01-11T02:00:00.000Z');
    assert.equal(summer.toISOString(), '2026-07-11T01:00:00.000Z');
    // Une heure murale identique, deux décalages : c'est la preuve que le
    // calcul se fait dans le fuseau et non sur un décalage figé.
    assert.equal(
      wallClock(winter, 'Europe/Paris').slice(-5),
      wallClock(summer, 'Europe/Paris').slice(-5),
    );
    assert.notEqual(
      winter.getTime() % 86_400_000,
      summer.getTime() % 86_400_000,
    );
  });

  check('la bascule d’heure d’été n’escamote aucune occurrence quotidienne', () => {
    // 2026-03-29 : l'Europe passe de 02:00 à 03:00 locale. Une tâche à 3 h a
    // bien une occurrence ce jour-là, et le décalage change d'un jour à l'autre.
    const runs = nextRuns('0 3 * * *', {
      from: new Date('2026-03-27T12:00:00.000Z'),
      count: 3,
      timeZone: 'Europe/Paris',
    });
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      [
        '2026-03-28T02:00:00.000Z', // encore UTC+1
        '2026-03-29T01:00:00.000Z', // bascule : UTC+2
        '2026-03-30T01:00:00.000Z',
      ],
    );
    for (const run of runs) assert.equal(wallClock(run, 'Europe/Paris').slice(-5), '03:00');
  });

  check('une heure murale qui n’existe pas ce jour-là est sautée, pas décalée', () => {
    // 02:30 locale n'existe pas le 2026-03-29 : l'horloge saute de 02:00 à 03:00.
    // La sauter est le seul choix honnête — la déplacer à 03:30 ferait tourner
    // la tâche à une heure que personne n'a demandée.
    const runs = nextRuns('30 2 * * *', {
      from: new Date('2026-03-28T12:00:00.000Z'),
      count: 2,
      timeZone: 'Europe/Paris',
    });
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      ['2026-03-30T00:30:00.000Z', '2026-03-31T00:30:00.000Z'],
    );
    for (const run of runs) assert.equal(wallClock(run, 'Europe/Paris').slice(-5), '02:30');
  });

  check('le retour à l’heure d’hiver rend un instant réel, une seule fois', () => {
    // 2026-10-25 : 02:30 locale a lieu deux fois. On en retient une, et c'en est
    // bien une — pas un instant fabriqué qui ne tomberait sur aucune horloge.
    const runs = nextRuns('30 2 * * *', {
      from: new Date('2026-10-24T12:00:00.000Z'),
      count: 2,
      timeZone: 'Europe/Paris',
    });
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(wallClock(run, 'Europe/Paris').slice(-5), '02:30');
    assert.notEqual(runs[0]?.getTime(), runs[1]?.getTime());
  });

  check('hémisphère sud : l’heure d’été joue en sens inverse', () => {
    // Auckland est UTC+13 en janvier (heure d'été) et UTC+12 en juillet.
    const summer = nextRuns('0 3 * * *', {
      from: new Date('2026-01-10T00:00:00.000Z'),
      count: 1,
      timeZone: 'Pacific/Auckland',
    })[0];
    const winter = nextRuns('0 3 * * *', {
      from: new Date('2026-07-10T00:00:00.000Z'),
      count: 1,
      timeZone: 'Pacific/Auckland',
    })[0];
    assert.ok(summer && winter);
    assert.equal(summer.toISOString(), '2026-01-10T14:00:00.000Z');
    assert.equal(winter.toISOString(), '2026-07-10T15:00:00.000Z');
  });

  check('un fuseau sans heure d’été garde le même décalage toute l’année', () => {
    for (const from of ['2026-01-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z']) {
      const run = nextRuns('0 3 * * *', {
        from: new Date(from),
        count: 1,
        timeZone: 'Asia/Tokyo',
      })[0];
      assert.ok(run);
      assert.equal(run.toISOString().slice(11), '18:00:00.000Z');
    }
  });

  check('la description porte le fuseau de la tâche', () => {
    assert.equal(
      describeCron('0 3 * * *', { timeZone: 'Europe/Paris' }),
      'tous les jours à 03:00 (Europe/Paris)',
    );
    assert.equal(
      describeCron('0 3 * * *', { timeZone: 'UTC' }),
      'tous les jours à 03:00 (UTC)',
    );
  });
}

step('7. Le fuseau est validé avant d’atteindre la base');
{
  for (const zone of ['UTC', 'Europe/Paris', 'Asia/Tokyo', 'America/Sao_Paulo', 'Pacific/Auckland']) {
    check(`« ${zone} » accepté`, () => {
      assert.equal(scheduleTimeZoneSchema.parse(zone), zone);
    });
  }

  // Un fuseau inventé en base ferait planter le calcul de la prochaine
  // occurrence : il est refusé à l'entrée, pas découvert à l'affichage.
  for (const zone of ['Europe/Atlantide', 'UTC+2', 'GMT+0200', 'paris', '']) {
    check(`« ${zone} » refusé`, () => {
      assert.equal(scheduleTimeZoneSchema.safeParse(zone).success, false);
    });
  }

  check('les tâches antérieures à la colonne sont en UTC, pas au fuseau d’instance', () => {
    assert.equal(LEGACY_SCHEDULE_TIMEZONE, 'UTC');
  });
}

step('Bilan');
if (failures === 0) {
  process.stdout.write(`  ${green('✓')} ${checks} vérifications, aucune défaillance\n\n`);
} else {
  process.stdout.write(`  ${red('✗')} ${failures} défaillance(s) sur ${checks} vérifications\n\n`);
  process.exit(1);
}
