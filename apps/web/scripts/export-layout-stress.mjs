/**
 * From apps/web: node scripts/export-layout-stress.mjs /tmp/sejire-layout
 * Add --boundaries after the output directory for the 14 extra generation-boundary fixtures.
 * Then: python3 scripts/check-layout-pdfs.py /tmp/sejire-layout (requires PyMuPDF).
 * This uses the application's fonts, JSON import/export and real PDF renderers.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || join(root, ".cache", "layout-stress"));
await mkdir(out, { recursive: true });
const vite = await createServer({
  root, configFile: false, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: null },
});

const maleNames = ["Әлихан", "Ержан", "Нұрлан", "Мұрат", "Төлеген", "Қайрат", "Серік"];
const femaleNames = ["Айша", "Жанар", "Меруерт", "Динара", "Сәуле", "Гүлнұр", "Шолпан"];
const load = name => vite.ssrLoadModule("/src/lib/" + name + ".ts");
try {
  const [{ renderClassicTreePdf }, { renderShezhirePdf, SHEZHIRE_TEMPLATES }, { primePdfFonts },
    { qaCompleteAncestrySnapshot, qaCompleteAncestryMeta }, { buildTreeExport, parseTreeJson },
    { defaultGuide }] = await Promise.all([
    "pdf/classicTreePdf", "pdf/shezhirePdf", "pdf/font", "pdf/thirteenLineage.fixture",
    "treeJson", "guide",
  ].map(load));
  const fonts = join(root, "src/assets/fonts");
  primePdfFonts(await readFile(join(fonts, "NotoSans-Regular.ttf"), "base64"),
    await readFile(join(fonts, "NotoSans-Bold.ttf"), "base64"));

  function person(id, name, sex, generation) {
    const year = 1994 - generation * 25;
    return { id, name, sex, parents: [], media: [], born: year + "-12-31",
      died: generation < 2 ? null : (year + 70) + "-11-30", birthPlace: "Сарыарқа" };
  }

  function line(depth, withMothers = false) {
    const persons = {};
    for (let i = 0; i < depth; i++) {
      const id = "f" + i, parentName = maleNames[(i + 1) % maleNames.length];
      const father = person(id, maleNames[i % maleNames.length] + " " + parentName + "ұлы", "M", i);
      persons[id] = father;
      if (i + 1 < depth) {
        father.parents = ["f" + (i + 1)];
        if (withMothers) {
          const mother = person("m" + (i + 1), femaleNames[i % femaleNames.length] + " Бекқызы", "F", i + 1);
          persons[mother.id] = mother;
          father.parents.push(mother.id);
        }
      }
    }
    return { persons };
  }

  const fixtures = [];
  function add(id, title, snapshot, focus, locale = "ru", clan = "Арғын", limits = []) {
    const meta = { ...qaCompleteAncestryMeta(7), id, title, clanName: clan };
    fixtures.push({ id, snapshot, meta, focus, locale, limits });
  }
  add("family-seven", "Жеті ұрпақ · Үлгі шежіре", line(7, true), "f0", "kk");

  // Deliberately exercise single unbreakable tokens, wide glyphs, mixed whitespace,
  // multi-line names, very long place and clan fields, and both full dates.
  const deep = line(40);
  for (let i = 0; i < 40; i++) {
    const p = deep.persons["f" + i];
    const suffix = ["", " " + "ШЖҚ".repeat(70), " " + "Әбдірахманұлы ".repeat(19).trimEnd(),
      " Қанатбекұлы\n\tҰлытау", " " + "WWMW".repeat(56)][i % 5];
    p.name = "Т" + String(i + 1).padStart(2, "0") + " " + p.name + suffix;
    p.birthPlace = "Ұлытау облысы " + "Қарағанды ".repeat(20).trimEnd();
  }
  add("line-forty", "Сынақ · 40 ұрпақ", deep, "f0", "ru",
    "Ұлытау " + "Қоңырат-Арғын ".repeat(33).trimEnd(), [1, 7, 13]);

  const wide = qaCompleteAncestrySnapshot(13);
  for (const p of Object.values(wide.persons)) {
    p.name = "Т" + p.id.slice(1).padStart(4, "0") + " " + p.name;
  }
  add("full-thirteen", "Полное дерево · 13 поколений", wide, "a1");

  // Width peaks in the middle: the final row alone is not a bound on poster width.
  const peak = qaCompleteAncestrySnapshot(7);
  let tip = peak.persons.a64;
  for (let i = 7; i < 19; i++) {
    const p = person("p" + i, "Т" + i + " " + maleNames[i % 7], "M", i);
    peak.persons[p.id] = p;
    tip.parents = [p.id];
    tip = p;
  }
  add("middle-peak", "Широкая ветвь и длинная линия", peak, "a1", "en");

  // Three vertices precede a cluster of eight ancestors: nominal binary slots
  // can collide at the page margin even when the actual row is almost empty.
  const sparse = line(10);
  const cluster = qaCompleteAncestrySnapshot(4);
  sparse.persons.f9.parents = cluster.persons.a1.parents;
  delete cluster.persons.a1;
  Object.assign(sparse.persons, cluster.persons);
  add("sparse-cluster", "Разреженное дерево · 13 поколений", sparse, "f0");

  const shared = qaCompleteAncestrySnapshot(3);
  shared.persons.a3.parents = ["a4", "a7"]; // a4 is an ancestor on both sides.
  shared.persons.a6.name = "Посторонняя запись";
  shared.persons.a7.tombstone = true;
  shared.persons.a7.name = "Удалённая запись";
  add("shared-ancestor", "Общий предок двух ветвей", shared, "a1");

  if (process.argv.includes("--boundaries")) {
    // Neighbors of 13-generation poster boundaries plus shallow and very
    // deep lines. A fixed seed keeps typography and branch density repeatable.
    const depths = [1, 2, 5, 8, 12, 13, 14, 24, 26, 27, 39, 41, 52, 103];
    const glyphs = ["Қ", "WWW", "ЖШ", "Ұ", "М", "ә", "Ғ", "Ң"];
    for (const [iteration, depth] of depths.entries()) {
      const snapshot = line(depth, iteration % 2 === 1);
      let state = 7293 + iteration;
      function next() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
      }
      for (const [i, p] of Object.values(snapshot.persons).entries()) {
        const token = glyphs[Math.floor(next() * glyphs.length)];
        const repeated = token.repeat(Math.floor(next() * 64));
        p.name = "Г" + String(i).padStart(3, "0") + " " + p.name + (i % 3 === 0 ? " " + repeated : "");
        if (p.sex === "F" && i % 7 === 0) {
          const prefix = "side" + i + "p";
          p.parents = [prefix + "1", prefix + "2"];
          snapshot.persons[prefix + "1"] = person(prefix + "1", "Е" + i + " Нұрлан", "M", 2);
          snapshot.persons[prefix + "2"] = person(prefix + "2", "Ә" + i + " Сәуле", "F", 2);
        }
        p.born = i % 4 === 0 ? null : "1804-04-25";
        p.died = i % 3 === 0 ? "1875" : null;
        p.birthPlace = i % 6 === 0 ? "Жаңа ауыл " + "Ұлытау ".repeat(50) : null;
      }
      // One field fills several appendix pages on its own, exposing repeated
      // running headers or lost continuation text in the serialized output.
      if (depth === 41) snapshot.persons.f2.name += " " + "ШежіреҚ".repeat(1800);
      add("edge-" + depth, "Үлгі " + depth, snapshot, "f0", ["ru", "en", "kk"][iteration % 3],
        iteration % 2 === 0 ? null : "Сарыарқа ".repeat(125));
    }
  }

  const manifest = { fixtures: [], files: [] };
  for (const f of fixtures) {
    const { persons } = f.snapshot;
    const guide = { ...defaultGuide(), selfId: f.focus, step: "done" };
    const store = { meta: f.meta, draft: f.snapshot, dirty: true, commits: {}, versions: {} };
    const tree = buildTreeExport(store, guide);
    const jsonFile = f.id + ".json";
    const json = JSON.stringify(tree);
    await writeFile(join(out, jsonFile), json);
    const restored = parseTreeJson(json);
    assert.ok(restored.ok);
    assert.equal(restored.guide.selfId, f.focus);
    assert.equal(Object.keys(restored.store.draft.persons).length, Object.keys(persons).length);
    for (const p of Object.values(persons)) {
      const imported = restored.store.draft.persons[p.id];
      assert.equal(imported.name, p.name);
      assert.deepEqual(imported.parents, p.parents);
      assert.equal(imported.tombstone, !!p.tombstone);
    }

    // Independent reference traversal using the source fixture. All parents
    // have explicit sex; disconnected and tombstoned people are excluded.
    const all = new Set();
    const queue = [f.focus];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i], p = persons[id];
      if (!p || p.tombstone || all.has(id)) continue;
      all.add(id);
      queue.push(...p.parents);
    }
    const paternal = [], seen = new Set();
    for (let p = persons[f.focus]; p && !p.tombstone && !seen.has(p.id);) {
      paternal.push(p.id);
      seen.add(p.id);
      p = persons[p.parents.find(id => persons[id]?.sex === "M" && !persons[id]?.tombstone)];
    }
    manifest.fixtures.push({ id: f.id, jsonFile, people: Object.keys(persons).length,
      ancestorsIncludingFocus: all.size, paternalIncludingFocus: paternal.length });
    const opts = { snapshot: restored.store.draft, meta: restored.store.meta, locale: f.locale };
    async function save(format, doc, expected, limit) {
      const filename = [f.id, format, limit && "limit-" + limit].filter(Boolean).join("-") + ".pdf";
      await writeFile(join(out, filename), new Uint8Array(doc.output("arraybuffer")));
      manifest.files.push({ filename, fixture: f.id, format, expected, limit });
      console.log(filename, "pages:", doc.getNumberOfPages(), "people:", expected.length);
    }
    await save("classic", await renderClassicTreePdf({ ...opts, focusId: f.focus }), [...all]);
    for (const { id: template } of SHEZHIRE_TEMPLATES) {
      for (const limit of [undefined, ...f.limits]) {
        const doc = await renderShezhirePdf({ ...opts, startId: f.focus, template, maxGenerations: limit });
        await save(template, doc, paternal.slice(0, limit ?? paternal.length), limit);
      }
    }
  }
  await writeFile(join(out, "layout-manifest.json"), JSON.stringify(manifest, null, 2));
} finally {
  await vite.close();
}
