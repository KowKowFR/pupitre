/**
 * Round trip between simplified periodicity and cron expression.
 *
 *   pnpm test:schedule
 *
 * What is proven here:
 *   1. `toCron` → `fromCron` → `toCron` is the identity over the whole
 *      `SimpleSchedule` space (exhaustive: 4 intervals, 60 minutes, 24×60
 *      hours, 127 weekday combinations, 31 days of the month — sampled where
 *      the Cartesian product becomes absurd).
 *   2. `fromCron` → `toCron` → `fromCron` is the identity on the expressions it
 *      accepts.
 *   3. `fromCron` returns `null` — and not an approximation — on the forms that
 *      have no simple equivalent.
 *   4. `describeCron` never returns the raw expression for an expression
 *      `fromCron` accepts, and does not lie about those it rejects.
 *   5. `nextRuns` falls on instants that really satisfy the expression, in the
 *      requested zone.
 *   6. The zone is indeed a **setting of the job**: the same expression in two
 *      zones falls on two different instants, and the UTC instant of a fixed
 *      local time follows the switch to summer time.
 *   7. `scheduleTimeZoneSchema` refuses a made-up IANA zone.
 *
 * Exit code 1 as soon as a single point fails.
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
} from '@pupitre/core';

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

/** All the non-empty weekday combinations: 2⁷ − 1 = 127. */
function everyWeekdayCombination(): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 128; mask += 1) {
    const days: number[] = [];
    for (let day = 0; day < 7; day += 1) if (mask & (1 << day)) days.push(day);
    out.push(days);
  }
  return out;
}

/** The complete space of simplified periodicities, sampled where needed. */
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
    // One hour/minute pair per combination is enough: the two dimensions are
    // independent, and the `daily` case already covers the 1440 minutes.
    out.push({ kind: 'weekly', weekdays, hour: weekdays.length % 24, minute: 7 });
  }
  for (let day = 1; day <= 31; day += 1) {
    out.push({ kind: 'monthly', day, hour: day % 24, minute: (day * 2) % 60 });
  }

  return out;
}

step('1. toCron → fromCron → toCron is the identity');
{
  const all = everySimpleSchedule();
  const broken: string[] = [];

  for (const simple of all) {
    const cron = toCron(simple);
    if (cronError(cron, 'en') !== null) {
      broken.push(`${JSON.stringify(simple)} produces "${cron}", refused by cronError`);
      continue;
    }
    const back = fromCron(cron);
    if (!back) {
      broken.push(`${JSON.stringify(simple)} → "${cron}" → fromCron returned null`);
      continue;
    }
    const again = toCron(back);
    if (again !== cron) {
      broken.push(`"${cron}" → ${JSON.stringify(back)} → "${again}"`);
      continue;
    }
    // The periodicity read back must also pass the schema: the cron coming out
    // right does not make the object valid.
    const parsed = simpleScheduleSchema.safeParse(back);
    if (!parsed.success) broken.push(`${JSON.stringify(back)} does not pass the Zod schema`);
  }

  checks += 1;
  if (broken.length === 0) {
    ok(`${all.length} periodicities, exact round trip`);
  } else {
    ko(`${broken.length} broken round trip(s) out of ${all.length}`, broken.slice(0, 5).join(' | '));
  }
}

step('2. fromCron → toCron → fromCron is the identity');
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
    // Equivalent forms, normalized by the round trip.
    '0 3 * * 7', // 7 = Sunday = 0
    '0 3 * * mon', // alias
    '0 3 * * MON,WED',
    '0 0 3 * * *', // six fields, second = 0
  ];

  for (const expression of accepted) {
    check(`"${expression}" read back in simple mode`, () => {
      const simple = fromCron(expression);
      assert.ok(simple, `fromCron returned null for "${expression}"`);
      const cron = toCron(simple);
      const again = fromCron(cron);
      assert.ok(again, `fromCron returned null for "${cron}"`);
      assert.deepEqual(again, simple, 'reading back does not return the same periodicity');
      assert.equal(toCron(again), cron, 'the normalized cron is not stable');
    });
  }
}

step('3. fromCron returns null rather than an approximation');
{
  const rejected: Array<[string, string]> = [
    ['*/7 2-5 * * 1,3', 'exotic step, hour range and list of days'],
    ['*/7 * * * *', 'interval outside the offered choices'],
    ['0 */3 * * *', 'step in the hour field'],
    ['0 2-5 * * *', 'hour range'],
    ['0 3 1 1 *', 'restricted month'],
    ['0 3 1 * 1', 'day of the month AND weekday — cron treats them as OR'],
    ['* * * * *', 'every minute'],
    ['* 3 * * *', 'every minute of one hour'],
    ['0,30 3 * * *', 'list of minutes'],
    ['0 3 * * 1-5', 'range of days'],
    ['30 0 3 * * *', 'six fields, second ≠ 0'],
    ['0 3 * *', 'four fields'],
    ['0 99 * * *', 'hour out of bounds'],
    ['not a cron at all', 'free text'],
  ];

  for (const [expression, why] of rejected) {
    check(`"${expression}" → null (${why})`, () => {
      assert.equal(fromCron(expression), null, `fromCron accepted "${expression}"`);
    });
  }
}

step('4. describeCron never lies');
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
    check(`"${expression}" → ${expected}`, () => {
      assert.equal(describeCron(expression, { locale: 'fr', timeZone: 'UTC' }), expected);
    });
  }

  check('locale anglaise', () => {
    assert.equal(
      describeCron('0 3 * * 1', { locale: 'en', timeZone: 'UTC' }),
      'on Mondays at 03:00 (UTC)',
    );
  });

  // The expressions fromCron refuses must still be described, without rounding:
  // it is the function's whole purpose.
  const approximated: Array<[string, string]> = [
    ['*/7 2-5 * * 1,3', 'toutes les 7 minutes, entre 2 h et 5 h 59, les lundis et mercredis (UTC)'],
    ['0 */3 * * *', 'à 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00 et 21:00 (UTC)'],
    ['0 3 1 * 1', 'à 03:00, le 1 du mois ou les lundis (UTC)'],
    ['* * * * *', 'chaque minute'],
  ];
  for (const [expression, expected] of approximated) {
    check(`"${expression}" described without rounding`, () => {
      const described = describeCron(expression, { locale: 'fr', timeZone: 'UTC' });
      assert.notEqual(described, expression, 'returned raw although it can be described');
      assert.equal(described, expected);
    });
  }

  check('an invalid expression is returned as is', () => {
    assert.equal(describeCron('0 99 * * *', { locale: 'fr' }), '0 99 * * *');
    assert.equal(describeCron('just anything', { locale: 'fr' }), 'just anything');
  });

  check('an interval carries no zone — it does not depend on one', () => {
    assert.equal(
      describeCron('*/5 * * * *', { locale: 'fr', timeZone: 'Europe/Paris' }),
      'toutes les 5 minutes',
    );
  });
}

step('5. nextRuns falls on instants that satisfy the expression');
{
  const from = new Date('2026-03-10T12:34:56.000Z');

  check('"0 3 * * *" in UTC → 03:00 UTC every day', () => {
    const runs = nextRuns('0 3 * * *', { from, count: 3, timeZone: 'UTC' });
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      ['2026-03-11T03:00:00.000Z', '2026-03-12T03:00:00.000Z', '2026-03-13T03:00:00.000Z'],
    );
  });

  check('"0 3 * * *" in Europe/Paris → 02:00 UTC (winter time)', () => {
    const winter = new Date('2026-01-10T12:00:00.000Z');
    const runs = nextRuns('0 3 * * *', { from: winter, count: 1, timeZone: 'Europe/Paris' });
    assert.equal(runs[0]?.toISOString(), '2026-01-11T02:00:00.000Z');
  });

  check('"0 4 * * 1" → a Monday', () => {
    const runs = nextRuns('0 4 * * 1', { from, count: 2, timeZone: 'UTC' });
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(run.getUTCDay(), 1, `${run.toISOString()} is not a Monday`);
    assert.equal(runs[0]?.toISOString(), '2026-03-16T04:00:00.000Z');
  });

  check('"*/15 * * * *" → four occurrences per hour', () => {
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

  check('"0 3 31 * *" skips the months that are too short', () => {
    const runs = nextRuns('0 3 31 * *', { from, count: 3, timeZone: 'UTC' });
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      ['2026-03-31T03:00:00.000Z', '2026-05-31T03:00:00.000Z', '2026-07-31T03:00:00.000Z'],
    );
  });

  check('"0 3 1 * 1": day of the month OR weekday', () => {
    const runs = nextRuns('0 3 1 * 1', { from, count: 4, timeZone: 'UTC' });
    for (const run of runs) {
      assert.ok(
        run.getUTCDate() === 1 || run.getUTCDay() === 1,
        `${run.toISOString()} is neither a 1st nor a Monday`,
      );
    }
  });

  check('an invalid expression returns no occurrence', () => {
    assert.deepEqual(nextRuns('0 99 * * *'), []);
    assert.deepEqual(nextRuns('just anything'), []);
  });

  check('all the occurrences are strictly after "from"', () => {
    for (const expression of ['*/5 * * * *', '0 3 * * *', '0 4 * * 1,3', '0 2 15 * *']) {
      for (const run of nextRuns(expression, { from, count: 5, timeZone: 'UTC' })) {
        assert.ok(run.getTime() > from.getTime(), `${expression} : ${run.toISOString()} ≤ from`);
      }
    }
  });
}

step('6. The zone is a setting of the job, not of the process');
{
  /** Wall-clock time of an instant, read in a zone. */
  const wallClock = (date: Date, timeZone: string): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);

  check('the same expression in two zones → two different instants', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const utc = nextRuns('0 3 * * *', { from, count: 1, timeZone: 'UTC' })[0];
    const paris = nextRuns('0 3 * * *', { from, count: 1, timeZone: 'Europe/Paris' })[0];
    const tokyo = nextRuns('0 3 * * *', { from, count: 1, timeZone: 'Asia/Tokyo' })[0];
    assert.ok(utc && paris && tokyo);
    assert.equal(utc.toISOString(), '2026-07-01T03:00:00.000Z');
    // Paris in July: UTC+2.
    assert.equal(paris.toISOString(), '2026-07-01T01:00:00.000Z');
    // Tokyo: UTC+9, all year round — 00:00 UTC is already 09:00 there, so the next
    // occurrence at 3 am local is the next day's.
    assert.equal(tokyo.toISOString(), '2026-07-01T18:00:00.000Z');
    assert.notEqual(utc.getTime(), paris.getTime());
    assert.notEqual(paris.getTime(), tokyo.getTime());
  });

  // The heart of the matter: "3 am in Paris" does NOT designate the same instant
  // in January and in July. It is exactly what a cron interpreted in UTC cannot
  // do — and the reason for the `tz` option.
  check('"0 3 * * *" in Paris: 02:00 UTC in winter, 01:00 UTC in summer', () => {
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
    // An identical wall-clock time, two offsets: it is the proof that the
    // computation is done in the zone and not on a frozen offset.
    assert.equal(
      wallClock(winter, 'Europe/Paris').slice(-5),
      wallClock(summer, 'Europe/Paris').slice(-5),
    );
    assert.notEqual(
      winter.getTime() % 86_400_000,
      summer.getTime() % 86_400_000,
    );
  });

  check('the switch to summer time skips no daily occurrence', () => {
    // 2026-03-29: Europe goes from 02:00 to 03:00 local. A 3 am job does have an
    // occurrence that day, and the offset changes from one day to the next.
    const runs = nextRuns('0 3 * * *', {
      from: new Date('2026-03-27T12:00:00.000Z'),
      count: 3,
      timeZone: 'Europe/Paris',
    });
    assert.deepEqual(
      runs.map((date) => date.toISOString()),
      [
        '2026-03-28T02:00:00.000Z', // still UTC+1
        '2026-03-29T01:00:00.000Z', // switch: UTC+2
        '2026-03-30T01:00:00.000Z',
      ],
    );
    for (const run of runs) assert.equal(wallClock(run, 'Europe/Paris').slice(-5), '03:00');
  });

  check('a wall-clock time that does not exist that day is skipped, not shifted', () => {
    // 02:30 local does not exist on 2026-03-29: the clock jumps from 02:00 to 03:00.
    // Skipping it is the only honest choice — moving it to 03:30 would run the job
    // at a time nobody asked for.
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

  check('the return to winter time yields a real instant, only once', () => {
    // 2026-10-25: 02:30 local happens twice. One is kept, and it is indeed one —
    // not a made-up instant that would fall on no clock.
    const runs = nextRuns('30 2 * * *', {
      from: new Date('2026-10-24T12:00:00.000Z'),
      count: 2,
      timeZone: 'Europe/Paris',
    });
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(wallClock(run, 'Europe/Paris').slice(-5), '02:30');
    assert.notEqual(runs[0]?.getTime(), runs[1]?.getTime());
  });

  check('southern hemisphere: summer time works the other way round', () => {
    // Auckland is UTC+13 in January (summer time) and UTC+12 in July.
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

  check('a zone without summer time keeps the same offset all year round', () => {
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

  check("the description carries the job's zone", () => {
    assert.equal(
      describeCron('0 3 * * *', { locale: 'fr', timeZone: 'Europe/Paris' }),
      'tous les jours à 03:00 (Europe/Paris)',
    );
    assert.equal(
      describeCron('0 3 * * *', { locale: 'fr', timeZone: 'UTC' }),
      'tous les jours à 03:00 (UTC)',
    );
  });
}

step('7. The zone is validated before reaching the database');
{
  for (const zone of ['UTC', 'Europe/Paris', 'Asia/Tokyo', 'America/Sao_Paulo', 'Pacific/Auckland']) {
    check(`"${zone}" accepted`, () => {
      assert.equal(scheduleTimeZoneSchema.parse(zone), zone);
    });
  }

  // A made-up zone in the database would crash the computation of the next
  // occurrence: it is refused at the entrance, not discovered at display time.
  for (const zone of ['Europe/Atlantide', 'UTC+2', 'GMT+0200', 'paris', '']) {
    check(`"${zone}" refused`, () => {
      assert.equal(scheduleTimeZoneSchema.safeParse(zone).success, false);
    });
  }

  check("the jobs older than the column are in UTC, not in the instance's zone", () => {
    assert.equal(LEGACY_SCHEDULE_TIMEZONE, 'UTC');
  });
}

step('Summary');
if (failures === 0) {
  process.stdout.write(`  ${green('✓')} ${checks} checks, no failure\n\n`);
} else {
  process.stdout.write(`  ${red('✗')} ${failures} failure(s) out of ${checks} checks\n\n`);
  process.exit(1);
}
