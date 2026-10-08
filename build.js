// Top Rated Films by Year — builds a static Stremio add-on (into docs/) listing the top films of every year,
// ranked like IMDb's Top 250, from IMDb's official non-commercial datasets.
// No dependencies: Node 18+ only.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');

// ---- Tuning (all the knobs live here) ----------------------------------------------------
const FIRST_YEAR = 1950;
const PER_YEAR = 250;          // max films per year
const MIN_RATING = 6.0;        // raw IMDb rating floor ("best of" shouldn't include 5s)
const MIN_RUNTIME = 60;        // minutes; drops featurettes mislabelled as movies
// Documentaries are in, but concert films (Documentary + Music) are out: they're fan-rated like a gig.
const isConcertFilm = (genres) => genres.includes('Documentary') && genres.includes('Music');
// Indian-language films from this year onwards are excluded: coordinated fan voting on release skews
// their IMDb ratings. Earlier years are untouched. India + language come from Wikidata (CC0).
const EXCLUDE_INDIAN_FROM = 2015;
// Per-year vote minimum: the vote count of that year's 500th most-voted film, kept between these.
const VOTE_FLOOR = 1000, VOTE_CEIL = 10000, VOTE_RANK = 500;
// From this year on, every film also needs at least this many votes (older years keep the scaled minimum above).
const MODERN_FROM = 2000, MODERN_MIN_VOTES = 20000;
// Per-year weighting strength ("m" in IMDb's formula): half the votes of the year's 50th most-voted film.
const M_FLOOR = 2000, M_CEIL = 50000, M_RANK = 50;
// ------------------------------------------------------------------------------------------

const OUT = path.join(__dirname, 'docs');
const BASE = 'https://momoneymoproblemo.github.io/top-rated-by-year';
const PAGE = 100; // Stremio pages catalogs with ?skip=100, 200...
const DATA = 'https://datasets.imdbws.com/';
const INDIA_CACHE = path.join(__dirname, 'data', 'india.json');

// Films Wikidata lists with India as a country of origin, keyed by IMDb id -> original languages.
function wikidataIndia() {
  const q = `SELECT ?imdb (GROUP_CONCAT(DISTINCT ?langLabel; separator="|") AS ?langs) WHERE {
    ?f wdt:P495 wd:Q668; wdt:P345 ?imdb.
    FILTER(STRSTARTS(?imdb, "tt"))
    OPTIONAL { ?f wdt:P364 ?lang. ?lang rdfs:label ?langLabel. FILTER(LANG(?langLabel) = "en") }
  } GROUP BY ?imdb`;
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'top-rated-by-year-stremio/1.0 (https://github.com/momoneymoproblemo/top-rated-by-year)' }, timeout: 180000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Wikidata HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const rows = JSON.parse(body).results.bindings;
          resolve(Object.fromEntries(rows.map((b) => [b.imdb.value, b.langs ? b.langs.value : ''])));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Wikidata timeout')));
    req.on('error', reject);
  });
}

async function loadIndia() {
  try {
    const india = await wikidataIndia();
    if (Object.keys(india).length < 10000) throw new Error('suspiciously few results');
    fs.mkdirSync(path.dirname(INDIA_CACHE), { recursive: true });
    fs.writeFileSync(INDIA_CACHE, JSON.stringify(india));
    return india;
  } catch (e) {
    console.warn(`  Wikidata unavailable (${e.message}); using cached list.`);
    if (fs.existsSync(INDIA_CACHE)) return JSON.parse(fs.readFileSync(INDIA_CACHE, 'utf8'));
    throw new Error('No Wikidata result and no cached list — cannot apply the India rule.');
  }
}

// Indian film whose languages are anything other than just English (unknown counts as Indian-language).
const isIndianLanguage = (india, id) => id in india && (india[id] === '' || india[id].split('|').some((l) => l !== 'English'));

function lines(file) {
  if (process.env.IMDB_DIR) { // local copies, for testing
    const input = fs.createReadStream(path.join(process.env.IMDB_DIR, file)).pipe(zlib.createGunzip());
    return Promise.resolve(readline.createInterface({ input, crlfDelay: Infinity }));
  }
  return new Promise((resolve, reject) => {
    https.get(DATA + file, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${file}: HTTP ${res.statusCode}`));
      resolve(readline.createInterface({ input: res.pipe(zlib.createGunzip()), crlfDelay: Infinity }));
    }).on('error', reject);
  });
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x || lo));
const fmtVotes = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));

function write(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

(async () => {
  const thisYear = new Date().getUTCFullYear();

  console.log('Fetching Indian film list from Wikidata…');
  const india = await loadIndia();
  console.log(`  ${Object.keys(india).length} films`);

  console.log('Reading ratings…');
  const ratings = new Map();
  let first = true;
  for await (const l of await lines('title.ratings.tsv.gz')) {
    if (first) { first = false; continue; }
    const [id, avg, votes] = l.split('\t');
    if (+votes >= 500) ratings.set(id, [+avg, +votes]);
  }
  console.log(`  ${ratings.size} titles with 500+ votes`);

  console.log('Reading titles…');
  const byYear = {};
  first = true;
  for await (const l of await lines('title.basics.tsv.gz')) {
    if (first) { first = false; continue; }
    const f = l.split('\t'); // tconst type primary original isAdult start end runtime genres
    if (f[1] !== 'movie' || f[4] !== '0') continue;
    const year = +f[5];
    if (!(year >= FIRST_YEAR && year <= thisYear)) continue;
    const r = ratings.get(f[0]);
    if (!r) continue;
    const runtime = +f[7] || 0;
    const genres = f[8] === '\\N' ? [] : f[8].split(',');
    if (runtime < MIN_RUNTIME || isConcertFilm(genres)) continue;
    (byYear[year] ||= []).push({ id: f[0], name: f[2], year, runtime, genres, rating: r[0], votes: r[1] });
  }

  const years = [];
  const summary = {};
  let defaultYear = null;
  fs.rmSync(path.join(OUT, 'catalog'), { recursive: true, force: true });

  for (let y = thisYear; y >= FIRST_YEAR; y--) {
    const films = byYear[y] || [];
    if (!films.length) continue;
    const votesDesc = films.map((f) => f.votes).sort((a, b) => b - a);
    const scaledMin = clamp(votesDesc[VOTE_RANK - 1], VOTE_FLOOR, VOTE_CEIL);
    const m = clamp(votesDesc[M_RANK - 1] / 2, M_FLOOR, M_CEIL);
    // The year's average (C) is worked out on the scaled pool so it means the same thing in every era.
    const basePool = films.filter((f) => f.votes >= scaledMin);
    if (!basePool.length) continue;
    const C = basePool.reduce((s, f) => s + f.rating, 0) / basePool.length;
    const pool = y >= MODERN_FROM ? basePool.filter((f) => f.votes >= MODERN_MIN_VOTES) : basePool;
    if (!pool.length) continue;
    const score = (f) => (f.votes / (f.votes + m)) * f.rating + (m / (f.votes + m)) * C;

    // The year's average and weighting are worked out on the full pool above; exclusions happen after.
    const excludeIndian = y >= EXCLUDE_INDIAN_FROM;
    const top = pool
      .filter((f) => f.rating >= MIN_RATING)
      .filter((f) => !(excludeIndian && isIndianLanguage(india, f.id)))
      .map((f) => ({ ...f, score: score(f) }))
      .sort((a, b) => b.score - a.score || b.votes - a.votes)
      .slice(0, PER_YEAR);
    if (!top.length) continue;

    const metas = top.map((f, i) => ({
      id: f.id,
      type: 'movie',
      name: f.name,
      poster: `https://images.metahub.space/poster/medium/${f.id}/img`,
      background: `https://images.metahub.space/background/medium/${f.id}/img`,
      releaseInfo: String(y),
      imdbRating: f.rating.toFixed(1),
      genres: f.genres,
      runtime: `${f.runtime} min`,
      description: `#${i + 1} of ${y} · IMDb ${f.rating.toFixed(1)} from ${fmtVotes(f.votes)} votes.`,
    }));

    for (let skip = 0; skip < metas.length; skip += PAGE) {
      write(`catalog/movie/top-by-year/genre=${y}${skip ? `&skip=${skip}` : ''}.json`, { metas: metas.slice(skip, skip + PAGE) });
    }
    // The default view (no year picked, e.g. the Board row) is the newest year with a decent list,
    // so early January doesn't show a near-empty new year.
    if (!defaultYear && metas.length >= 100) {
      defaultYear = y;
      for (let skip = 0; skip < metas.length; skip += PAGE) {
        write(`catalog/movie/top-by-year${skip ? `/skip=${skip}` : ''}.json`, { metas: metas.slice(skip, skip + PAGE) });
      }
    }
    years.push(String(y));
    summary[y] = { count: metas.length, top: metas.slice(0, 3).map((x) => x.name) };
  }

  const manifest = {
    id: 'community.topratedbyyear',
    version: '1.2.0',
    name: 'Top Rated Films by Year',
    description: `The highest-rated films of every year from ${FIRST_YEAR} to today, best first. Ranked by IMDb ratings with a vote minimum, refreshed weekly. Indian-language films from ${EXCLUDE_INDIAN_FROM} onwards are excluded because coordinated voting skews their ratings. Unofficial.`,
    logo: `${BASE}/logo.png`,
    background: `${BASE}/background.png`,
    resources: ['catalog'],
    types: ['movie'],
    idPrefixes: ['tt'],
    catalogs: [
      {
        type: 'movie',
        id: 'top-by-year',
        name: 'Top Rated by Year',
        extra: [
          { name: 'genre', options: years, isRequired: false },
          { name: 'skip', isRequired: false },
        ],
        genres: years,
      },
    ],
  };
  write('manifest.json', manifest);
  write('summary.json', { updated: new Date().toISOString(), defaultYear, years: summary });
  if (!years.length) throw new Error('No years built — check the IMDb download.');

  for (const y of years.slice(0, 3).concat(years.slice(-1))) {
    console.log(`${y}: ${summary[y].count} films — ${summary[y].top.join(', ')}`);
  }
  console.log(`Built ${years.length} years.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
