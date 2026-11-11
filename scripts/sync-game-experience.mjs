import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readGit } from "../apps/desktop/workspace.mjs";
import { validateGameExperienceCatalog, validateGameExperienceRecord } from "../apps/desktop/game-experience.mjs";

const lab = process.argv[2];
if (!lab || process.argv.length !== 3) throw new Error("LAB_REPOSITORY_REQUIRED");
const root = resolve(lab), path = "knowledge/game-agent-lessons.json";
const revision = (await readGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("LAB_REVISION_REQUIRED");
const content = await readGit(root, ["show", revision + ":" + path], { bytes: true, maxBuffer: 65536 });
const catalog = validateGameExperienceCatalog(JSON.parse(content.toString("utf8")));
const hash = value => createHash("sha256").update(value).digest("hex");
const source = { repository: "Arcueid77/Spherewright-Lab", revision, path, fileSha256: hash(content) };
validateGameExperienceRecord({ version: 1, source, lessonIds: catalog.lessons.map(lesson => lesson.id) });
await writeFile(new URL("../apps/desktop/game-experience.bundle.json", import.meta.url), JSON.stringify({ source, catalogSha256: hash(JSON.stringify(catalog)), catalog }, null, 2) + "\n");
console.log(JSON.stringify({ sourceRevision: revision, lessons: catalog.lessons.length, fileSha256: source.fileSha256 }));
